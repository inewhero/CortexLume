import type { FunctionalTargetMap, QuickTargetSummary } from '@cortexlume/contracts';

export type QuickTargetSearchItem = QuickTargetSummary;

type QuickTargetBridge = {
  quickTargetSearch?: (query: string, limit?: number) => Promise<unknown>;
  quickTargetMap?: (id: string) => Promise<FunctionalTargetMap>;
};

const stringValue = (...values: unknown[]): string | null => {
  const match = values.find((value) => typeof value === 'string' && value.trim());
  return typeof match === 'string' ? match.trim() : null;
};

const numberValue = (...values: unknown[]): number | null => {
  const match = values.find((value) => typeof value === 'number' && Number.isFinite(value));
  return typeof match === 'number' ? match : null;
};

const recordValue = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const arrayValue = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

function quickTargetBridge(): QuickTargetBridge | null {
  const api = (window as unknown as { cortexlume?: { science?: QuickTargetBridge; quickTarget?: QuickTargetBridge } }).cortexlume;
  return api?.science ?? api?.quickTarget ?? null;
}

export function quickTargetAvailable(): boolean {
  const bridge = quickTargetBridge();
  return typeof bridge?.quickTargetSearch === 'function' && typeof bridge.quickTargetMap === 'function';
}

export async function searchQuickTargets(query: string): Promise<QuickTargetSearchItem[]> {
  const search = quickTargetBridge()?.quickTargetSearch;
  if (!search) throw new Error('Quick Target data is not available in this build.');
  const response = await search(query.trim(), 24);
  const root = recordValue(response);
  const candidates = arrayValue(Array.isArray(response) ? response : root.results ?? root.targets ?? root.items);
  return candidates.flatMap((candidate) => {
    const item = recordValue(candidate);
    const id = stringValue(item.id, item.slug, item.termId, item.term);
    const label = stringValue(item.label, item.name, item.term, id);
    if (!id || !label) return [];
    return [{
      id,
      label,
      studyCount: numberValue(item.studyCount, item.study_count, item.nStudies, item.studies),
      aliases: arrayValue(item.aliases).filter((value): value is string => typeof value === 'string'),
      domain: typeof item.domain === 'string' ? item.domain : undefined,
      subdomain: typeof item.subdomain === 'string' ? item.subdomain : undefined,
      description: stringValue(item.description) ?? undefined,
      peakRegions: arrayValue(item.peakRegions ?? item.peak_regions).flatMap((region) => {
        if (typeof region === 'string') return [region];
        const regionRecord = recordValue(region);
        const regionLabel = stringValue(regionRecord.label, regionRecord.name, regionRecord.region);
        return regionLabel ? [regionLabel] : [];
      }),
      laterality: stringValue(item.laterality, item.hemisphere) ?? undefined,
    }];
  });
}

export async function loadQuickTarget(id: string): Promise<FunctionalTargetMap> {
  const load = quickTargetBridge()?.quickTargetMap;
  if (!load) throw new Error('Quick Target data is not available in this build.');
  return load(id);
}
