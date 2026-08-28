import {
  CROSS_PROCESS_LIMITS,
  ProjectOperationOptionsSchema,
  ProjectOperationProgressSchema,
  type ProjectOperationProgress,
} from '@cortexlume/contracts';
import { randomUUID } from 'node:crypto';

export type ProjectOperationKind = 'annotation' | 'export';

export interface ProjectOperation {
  id: string;
  operation: ProjectOperationKind;
  controller: AbortController;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
}

export type ProjectOperationProgressSink = (progress: ProjectOperationProgress) => void;

/**
 * Owns operation cancellation/deadline state independently from Electron.
 * Keeping this lifecycle small and transport-free makes the actual IPC
 * operation semantics testable without starting a BrowserWindow.
 */
export class ProjectOperationManager {
  private readonly operations = new Map<string, ProjectOperation>();

  constructor(private readonly onProgress: ProjectOperationProgressSink = () => undefined) {}

  start(operation: ProjectOperationKind, rawOptions: unknown): ProjectOperation {
    const options = ProjectOperationOptionsSchema.parse(rawOptions ?? {});
    const id = options.operationId ?? randomUUID();
    if (this.operations.has(id)) throw new Error(`Project operation ${id} is already running`);
    const controller = new AbortController();
    const deadline = Date.now() + (options.timeoutMs ?? CROSS_PROCESS_LIMITS.projectOperationTimeoutMs);
    const context: ProjectOperation = {
      id,
      operation,
      controller,
      deadline,
      timer: setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now())),
    };
    this.operations.set(id, context);
    this.emit(context, 'started', 0, 1);
    return context;
  }

  get(operationId: string): ProjectOperation | undefined {
    return this.operations.get(operationId);
  }

  cancel(operationId: string): boolean {
    const context = this.operations.get(operationId);
    if (!context) return false;
    context.controller.abort();
    return true;
  }

  check(context: ProjectOperation): void {
    if (Date.now() >= context.deadline) {
      context.controller.abort();
      throw new Error(`Project ${context.operation} exceeded its overall time budget`);
    }
    if (context.controller.signal.aborted) throw new Error(`Project ${context.operation} cancelled`);
  }

  finish(context: ProjectOperation): void {
    clearTimeout(context.timer);
    if (this.operations.get(context.id) === context) this.operations.delete(context.id);
  }

  async run<T>(
    operation: ProjectOperationKind,
    rawOptions: unknown,
    task: (context: ProjectOperation) => Promise<T>,
  ): Promise<T> {
    const context = this.start(operation, rawOptions);
    try {
      this.check(context);
      const result = await task(context);
      this.check(context);
      this.emit(context, 'completed', 1, 1);
      return result;
    } catch (error) {
      if (!context.controller.signal.aborted) throw error;
      const deadlineExceeded = Date.now() >= context.deadline;
      this.emit(context, deadlineExceeded ? 'deadline-exceeded' : 'cancelled', 0, 1);
      throw new Error(
        deadlineExceeded
          ? `Project ${context.operation} exceeded its overall time budget`
          : `Project ${context.operation} cancelled`,
        { cause: error },
      );
    } finally {
      this.finish(context);
    }
  }

  private emit(context: ProjectOperation, phase: string, completed: number, total: number): void {
    this.onProgress(ProjectOperationProgressSchema.parse({
      operationId: context.id,
      operation: context.operation,
      phase,
      completed,
      total: Math.max(1, total),
    }));
  }
}
