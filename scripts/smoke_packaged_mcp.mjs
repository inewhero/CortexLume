import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const executable = path.resolve(process.argv[2] ?? 'apps/desktop/out/CortexLume-win32-x64/CortexLume.exe');
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'cortexlume-packaged-mcp-'));
const inheritedEnvironment = Object.fromEntries(
  Object.entries(process.env).filter((entry) => typeof entry[1] === 'string'),
);
const transport = new StdioClientTransport({
  command: executable,
  args: ['--mcp-stdio', `--mcp-root=${temporaryRoot}`],
  cwd: path.dirname(executable),
  env: inheritedEnvironment,
  stderr: 'pipe',
});
let stderr = '';
transport.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
const client = new Client({ name: 'cortexlume-packaged-smoke', version: '1.0.0' });

function structured(result) {
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return result.structuredContent;
}

function runGui(projectPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [projectPath], {
      cwd: path.dirname(executable),
      env: { ...inheritedEnvironment, CORTEXLUME_HEADLESS_TEST: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Packaged GUI project launch did not exit after the headless smoke timeout.'));
    }, 20_000);
    child.once('error', reject);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`Packaged GUI exited with code ${code}: ${output}`));
    });
  });
}

function verifyProtocolOnlyStdout() {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--mcp-stdio', `--mcp-root=${temporaryRoot}`], {
      cwd: path.dirname(executable),
      env: inheritedEnvironment,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let buffer = '';
    let stderrOutput = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Raw MCP protocol check timed out: ${stderrOutput}`));
    }, 20_000);
    const finish = (error) => {
      clearTimeout(timeout);
      child.stdin.end();
      if (error) reject(error);
      else resolve();
    };
    child.stderr.on('data', (chunk) => { stderrOutput += chunk.toString(); });
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes('\n')) {
        const newline = buffer.indexOf('\n');
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch {
          finish(new Error(`Non-protocol stdout from packaged MCP: ${line}`));
          return;
        }
        if (message.id === 1) finish();
      }
    });
    child.once('error', finish);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw-smoke', version: '1.0.0' } },
    })}\n`);
  });
}

try {
  process.stderr.write('packaged smoke: raw stdout protocol\n');
  await verifyProtocolOnlyStdout();
  process.stderr.write('packaged smoke: connect\n');
  await client.connect(transport);
  process.stderr.write('packaged smoke: list tools\n');
  const tools = await client.listTools();
  const expectedTools = [
    'get_capabilities', 'search_targets', 'list_atlas_regions', 'plan_project',
    'save_project', 'inspect_project', 'open_project',
  ];
  if (tools.tools.map((tool) => tool.name).join(',') !== expectedTools.join(',')) {
    throw new Error(`Unexpected packaged MCP tools: ${tools.tools.map((tool) => tool.name).join(', ')}`);
  }
  process.stderr.write('packaged smoke: capabilities\n');
  const capabilities = structured(await client.callTool({ name: 'get_capabilities', arguments: {} }));
  if (capabilities.projectFormatVersion !== 2 || !capabilities.assets?.ready) {
    throw new Error(`Packaged capabilities are not ready: ${JSON.stringify(capabilities)}`);
  }
  process.stderr.write('packaged smoke: search target\n');
  const search = structured(await client.callTool({
    name: 'search_targets', arguments: { query: 'working memory', limit: 5 },
  }));
  const target = search.targets?.[0];
  if (!target?.id) throw new Error('Packaged Quick Target search returned no target.');
  process.stderr.write('packaged smoke: plan project\n');
  const planningStartedAt = performance.now();
  const planned = structured(await client.callTool({
    name: 'plan_project', arguments: { target: { kind: 'quick-target', id: target.id }, seed: 'packaged-smoke-v2' },
  }, { timeout: 300_000 }));
  const planningDurationMs = Math.round(performance.now() - planningStartedAt);
  if (planned.candidates?.length !== 3) throw new Error('Packaged planner did not return three candidates.');
  process.stderr.write(`packaged smoke: save project (${planningDurationMs} ms planning)\n`);
  const destination = path.join(temporaryRoot, 'packaged-agent-plan.cortexlume');
  const saved = structured(await client.callTool({
    name: 'save_project',
    arguments: {
      planId: planned.planId,
      candidateId: planned.recommendedCandidateId,
      outputPath: destination,
      projectName: 'Packaged Agent Smoke',
    },
  }));
  process.stderr.write('packaged smoke: inspect project\n');
  const inspection = structured(await client.callTool({ name: 'inspect_project', arguments: { path: saved.path } }));
  if (inspection.formatVersion !== 2 || inspection.functionalTarget?.target?.id !== target.id) {
    throw new Error('Packaged project inspection did not preserve the v2 target.');
  }
  process.stderr.write('packaged smoke: launch project\n');
  await client.close();
  await runGui(saved.path);
  process.stdout.write(`${JSON.stringify({
    executable,
    tools: expectedTools.length,
    target: target.id,
    candidates: planned.candidates.length,
    planningDurationMs,
    formatVersion: inspection.formatVersion,
    stdoutProtocolOnly: 'passed',
    guiProjectLaunch: 'passed',
  }, null, 2)}\n`);
} catch (error) {
  await client.close().catch(() => {});
  if (stderr.trim()) process.stderr.write(`MCP stderr:\n${stderr}\n`);
  throw error;
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
