import { useEffect, useId, useRef, useState } from 'react';
import type { QuickTargetSummary } from '@cortexlume/contracts';
import {
  loadQuickTarget,
  quickTargetAvailable,
  searchQuickTargets,
  type QuickTargetSearchItem,
} from '../lib/quickTarget';
import { useProjectStore } from '../store/projectStore';
import './QuickTarget.css';

type SearchState = 'idle' | 'loading' | 'ready' | 'error';

const NEUROSYNTH_COMPOSE_URL = 'https://compose.neurosynth.org/';

function TargetDescription({ description }: { description: string }) {
  const parts = description.split(/(Neurosynth)/gi);
  return <p className="target-description">{parts.map((part, index) => part.toLowerCase() === 'neurosynth'
    ? <a key={`${part}-${index}`} href={NEUROSYNTH_COMPOSE_URL} target="_blank" rel="noopener noreferrer">{part}</a>
    : part)}</p>;
}

export interface QuickTargetProps {
  selectedTarget: QuickTargetSummary | null;
  statistic?: string | undefined;
  visible?: boolean;
  onSelect(id: string): Promise<void> | void;
  onClear(): void;
  onToggleVisible?(): void;
  onImportNifti?(): void;
}

export function QuickTarget({ selectedTarget, statistic, visible = false, onSelect, onClear, onToggleVisible, onImportNifti }: QuickTargetProps) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<QuickTargetSearchItem[]>([]);
  const [searchState, setSearchState] = useState<SearchState>('idle');
  const [mapLoadingId, setMapLoadingId] = useState<string | null>(null);
  const [failedItem, setFailedItem] = useState<QuickTargetSearchItem | null>(null);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const resultsId = useId();
  const available = quickTargetAvailable();

  const runSearch = async (nextQuery = query) => {
    if (!available) return;
    const currentRequest = ++requestId.current;
    setSearchState('loading');
    setError(null);
    setFailedItem(null);
    try {
      const nextResults = await searchQuickTargets(nextQuery);
      if (requestId.current !== currentRequest) return;
      setResults(nextResults);
      setSearchState('ready');
    } catch (reason) {
      if (requestId.current !== currentRequest) return;
      setResults([]);
      setSearchState('error');
      setError(reason instanceof Error ? reason.message : 'Target search failed.');
    }
  };

  useEffect(() => {
    if (!available || !expanded) return undefined;
    const timeout = window.setTimeout(() => void runSearch(query), query ? 260 : 0);
    return () => window.clearTimeout(timeout);
    // runSearch deliberately follows the current query while requestId discards stale responses.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, available, expanded]);

  useEffect(() => {
    setChanging(false);
    setMapLoadingId(null);
  }, [selectedTarget?.id]);

  const selectTarget = async (item: QuickTargetSearchItem) => {
    const currentRequest = ++requestId.current;
    setMapLoadingId(item.id);
    setError(null);
    setFailedItem(null);
    try {
      await onSelect(item.id);
      if (requestId.current !== currentRequest) return;
      setQuery('');
      setResults([]);
      setSearchState('idle');
    } catch (reason) {
      if (requestId.current !== currentRequest) return;
      setError(reason instanceof Error ? reason.message : 'Target map could not be loaded.');
      setFailedItem(item);
    } finally {
      if (requestId.current === currentRequest) setMapLoadingId(null);
    }
  };

  const clearTarget = () => {
    requestId.current += 1;
    setMapLoadingId(null);
    setError(null);
    setFailedItem(null);
    setChanging(false);
    onClear();
  };

  const target = selectedTarget;
  const showPicker = !target || changing;

  return (
    <section className={`quick-target ${target ? 'has-target' : ''} ${expanded ? 'is-expanded' : 'is-collapsed'}`} aria-labelledby={`${resultsId}-title`}>
      <button
        type="button"
        className="quick-target-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <strong id={`${resultsId}-title`}>FUNCTIONAL TARGET</strong>
        <span>{target ? target.label : 'UNTARGETED'}</span>
        <code>{expanded ? '−' : '+'}</code>
      </button>

      <div className="quick-target-body" aria-hidden={!expanded}>
        {target && !showPicker ? (
          <div className="quick-target-active">
            <div className="target-active-head">
              <div><strong>{target.label}</strong>{(target.domain || target.subdomain) && <span>{[target.domain, target.subdomain].filter(Boolean).join(' / ')}</span>}<span>{statistic?.toUpperCase() ?? 'ASSOCIATION Z'}</span></div>
              <div className="target-active-actions">
                {onToggleVisible && <button type="button" className={visible ? 'active' : ''} onClick={onToggleVisible}>{visible ? 'HIDE' : 'SHOW'}</button>}
                <button type="button" onClick={clearTarget} aria-label={`Clear ${target.label} target`}>CLEAR</button>
              </div>
            </div>
            {target.description && <TargetDescription description={target.description} />}
            <dl className="target-facts">
              <div><dt>STUDIES</dt><dd>{target.studyCount?.toLocaleString() ?? '—'}</dd></div>
              <div><dt>SIDE</dt><dd>{target.laterality?.toUpperCase() ?? '—'}</dd></div>
            </dl>
            {(target.peakRegions?.length ?? 0) > 0 && <div className="target-regions"><span>PEAK REGIONS</span><ol>{target.peakRegions?.slice(0, 3).map((region) => <li key={region}><span>{region}</span></li>)}</ol></div>}
            <p className="target-guidance"><b>HEATMAP ACTIVE IN 3D ALIGN.</b> Design the S/D geometry below, then place the patch over the highlighted cortex.</p>
            <div className="target-source-actions">
              <button className="target-change" type="button" onClick={() => { setChanging(true); setQuery(''); void runSearch(''); }}>QUICK TARGET</button>
              {onImportNifti && <button type="button" onClick={onImportNifti}>NIFTI MAP</button>}
            </div>
          </div>
        ) : (
          <div className="quick-target-picker">
            <div className="target-picker-intro"><p>{target ? `Choose a replacement for ${target.label}. The current layout will not change.` : 'Choose a literature-derived cortical target before designing the optode geometry.'}</p>{target && <button type="button" onClick={() => setChanging(false)}>CANCEL</button>}</div>
            {onImportNifti && <button className="target-import-nifti" type="button" onClick={onImportNifti}>IMPORT NIFTI TARGET MAP</button>}
            <form role="search" onSubmit={(event) => { event.preventDefault(); void runSearch(); }}>
              <input
                type="search"
                aria-label="Search cognitive target"
                aria-controls={resultsId}
                placeholder="e.g. working memory"
                value={query}
                disabled={!available}
                onChange={(event) => setQuery(event.target.value)}
                autoComplete="off"
              />
              <button type="submit" disabled={!available || searchState === 'loading'}>SEARCH</button>
            </form>
            {!available && <div className="target-status is-muted">QUICK TARGET PACK NOT INSTALLED</div>}
            {available && searchState === 'loading' && <div className="target-status" role="status">SEARCHING TARGET CATALOG…</div>}
            {available && searchState === 'ready' && results.length === 0 && <div className="target-status">{query ? 'NO MATCHES. TRY A BROADER TERM.' : 'NO TARGETS IN THIS PACK.'}</div>}
            {results.length > 0 && <div className="target-results" id={resultsId} aria-label="Cognitive target results">
              {results.map((item) => <button
                type="button"
                key={item.id}
                disabled={mapLoadingId !== null}
                aria-busy={mapLoadingId === item.id}
                onClick={() => void selectTarget(item)}
              ><span><strong>{item.label}</strong>{(item.domain || item.subdomain) && <small>{[item.domain, item.subdomain].filter(Boolean).join(' / ')}</small>}{item.aliases.length > 0 && <small>{item.aliases.slice(0, 2).join(' · ')}</small>}</span><code>{mapLoadingId === item.id ? 'LOADING' : item.studyCount == null ? 'SELECT' : `${item.studyCount.toLocaleString()} STUDIES`}</code></button>)}
            </div>}
          </div>
        )}
        {error && <div className="target-error" role="alert"><span>{error}</span><button type="button" onClick={() => { setError(null); if (failedItem) void selectTarget(failedItem); else void runSearch(); }}>RETRY</button></div>}
      </div>
    </section>
  );
}

/** Bridge-backed owner kept separate so QuickTarget remains reusable and controlled. */
export function QuickTargetController({ onImportNifti }: { onImportNifti?: () => void }) {
  const functionalTarget = useProjectStore((state) => state.functionalTarget);
  const visible = useProjectStore((state) => state.project.surfaceOverlay === 'functional-target');
  const setFunctionalTarget = useProjectStore((state) => state.setFunctionalTarget);
  const setFunctionalTargetVisible = useProjectStore((state) => state.setFunctionalTargetVisible);
  return <QuickTarget
    selectedTarget={functionalTarget?.target ?? null}
    statistic={functionalTarget?.provenance.statistic}
    visible={visible}
    onSelect={async (id) => {
      const nextTarget = await loadQuickTarget(id);
      setFunctionalTarget(nextTarget);
    }}
    onClear={() => setFunctionalTarget(null)}
    onToggleVisible={() => setFunctionalTargetVisible(!visible)}
    {...(onImportNifti ? { onImportNifti } : {})}
  />;
}
