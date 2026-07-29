import { useEffect, useRef, useState } from 'react';
import type { DeviceProfile } from '@cortexlume/contracts';
import { useProjectStore } from '../store/projectStore';

const BIDS_TYPES: Array<{ value: DeviceProfile['measurementType']; label: string }> = [
  { value: 'NIRSCWAMPLITUDE', label: 'CW amplitude' },
  { value: 'NIRSCWOPTICALDENSITY', label: 'Optical density' },
  { value: 'NIRSCWHBO', label: 'Oxy-Hb' },
  { value: 'NIRSCWHBR', label: 'Deoxy-Hb' },
  { value: 'NIRSCWMUA', label: 'Absorption' },
];

function bidsLabel(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, '');
}

export function BidsSettings() {
  const {
    project, bidsSettingsExpanded, bidsValidationFields,
    setDeviceProfile, setBidsSettings, setBidsSettingsExpanded,
  } = useProjectStore();
  const { bidsSettings, deviceProfile } = project;
  const [wavelengthDraft, setWavelengthDraft] = useState(deviceProfile.wavelengthsNm.join(', '));
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setWavelengthDraft(deviceProfile.wavelengthsNm.join(', '));
  }, [deviceProfile.wavelengthsNm]);

  useEffect(() => {
    if (!bidsSettingsExpanded || bidsValidationFields.length === 0) return;
    panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const firstField = bidsValidationFields[0];
    window.setTimeout(() => {
      panelRef.current
        ?.querySelector<HTMLElement>(`[data-bids-field="${firstField}"] input, [data-bids-field="${firstField}"] select`)
        ?.focus();
    }, 280);
  }, [bidsSettingsExpanded, bidsValidationFields]);

  const commitWavelengths = () => {
    const values = wavelengthDraft
      .split(/[\s,;]+/)
      .map(Number)
      .filter((value) => Number.isFinite(value) && value > 0);
    if (values.length > 0) {
      const unique = [...new Set(values)];
      setDeviceProfile({ wavelengthsNm: unique });
      setWavelengthDraft(unique.join(', '));
    } else {
      setWavelengthDraft(deviceProfile.wavelengthsNm.join(', '));
    }
  };

  return (
    <section ref={panelRef} className={`control-block bids-settings-panel${bidsSettingsExpanded ? ' is-expanded' : ' is-collapsed'}`}>
      <button
        type="button"
        className="control-block-title bids-settings-toggle"
        aria-expanded={bidsSettingsExpanded}
        onClick={() => setBidsSettingsExpanded(!bidsSettingsExpanded)}
      >
        <span>DEVICE</span>
        <code>{bidsSettingsExpanded ? '−' : '+'}</code>
      </button>
      <div className="bids-settings-body">
        <div className="bids-subtitle">DATASET ENTITIES</div>
        <div className="parameter-grid three">
          <label data-bids-field="subjectLabel"><span>SUBJECT</span><input value={bidsSettings.subjectLabel} onChange={(event) => setBidsSettings({ subjectLabel: bidsLabel(event.target.value) || '01' })} /></label>
          <label><span>SESSION</span><input placeholder="optional" value={bidsSettings.sessionLabel} onChange={(event) => setBidsSettings({ sessionLabel: bidsLabel(event.target.value) })} /></label>
          <label data-bids-field="taskLabel"><span>TASK</span><input value={bidsSettings.taskLabel} onChange={(event) => setBidsSettings({ taskLabel: bidsLabel(event.target.value) || 'layout' })} /></label>
          <label><span>ACQUISITION</span><input placeholder="optional" value={bidsSettings.acquisitionLabel} onChange={(event) => setBidsSettings({ acquisitionLabel: bidsLabel(event.target.value) })} /></label>
          <label><span>RUN</span><input type="number" min={1} placeholder="optional" value={bidsSettings.runIndex ?? ''} onChange={(event) => setBidsSettings({ runIndex: event.target.value ? Math.max(1, Number(event.target.value)) : null })} /></label>
        </div>

        <div className="bids-subtitle">INSTRUMENT PROFILE</div>
        <div className="parameter-grid two">
          <label data-bids-field="manufacturer"><span>MANUFACTURER</span><input value={deviceProfile.manufacturer} onChange={(event) => setDeviceProfile({ manufacturer: event.target.value })} onBlur={() => { if (!deviceProfile.manufacturer.trim()) setDeviceProfile({ manufacturer: 'Shimadzu' }); }} /></label>
          <label data-bids-field="model"><span>MODEL</span><input value={deviceProfile.model} onChange={(event) => setDeviceProfile({ model: event.target.value })} onBlur={() => { if (!deviceProfile.model.trim()) setDeviceProfile({ model: 'LABNIRS' }); }} /></label>
          <label data-bids-field="wavelengthsNm"><span>WAVELENGTHS NM</span><input value={wavelengthDraft} onChange={(event) => setWavelengthDraft(event.target.value)} onBlur={commitWavelengths} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} /></label>
          <label data-bids-field="measurementType">
            <span>MEASUREMENT</span>
            <select value={deviceProfile.measurementType} onChange={(event) => setDeviceProfile({ measurementType: event.target.value as DeviceProfile['measurementType'] })}>
              {BIDS_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <label data-bids-field="units"><span>UNITS</span><input value={deviceProfile.units} onChange={(event) => setDeviceProfile({ units: event.target.value })} onBlur={() => { if (!deviceProfile.units.trim()) setDeviceProfile({ units: 'V' }); }} /></label>
          <label data-bids-field="samplingFrequencyHz"><span>SAMPLING HZ</span><input type="number" min={0.001} step="any" placeholder="required" value={deviceProfile.samplingFrequencyHz ?? ''} onChange={(event) => setDeviceProfile({ samplingFrequencyHz: event.target.value ? Math.max(0.001, Number(event.target.value)) : null })} /></label>
        </div>
      </div>
    </section>
  );
}
