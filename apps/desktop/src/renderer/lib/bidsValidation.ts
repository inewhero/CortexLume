import type { CortexLumeProject } from '@cortexlume/contracts';

export type BidsField =
  | 'subjectLabel'
  | 'taskLabel'
  | 'manufacturer'
  | 'model'
  | 'wavelengthsNm'
  | 'measurementType'
  | 'units'
  | 'samplingFrequencyHz';

export interface MissingBidsField {
  key: BidsField;
  label: string;
}

export function getMissingBidsFields(project: CortexLumeProject): MissingBidsField[] {
  const { bidsSettings, deviceProfile } = project;
  const fields: Array<[BidsField, string, boolean]> = [
    ['subjectLabel', 'Subject', bidsSettings.subjectLabel.trim().length > 0],
    ['taskLabel', 'Task', bidsSettings.taskLabel.trim().length > 0],
    ['manufacturer', 'Manufacturer', deviceProfile.manufacturer.trim().length > 0],
    ['model', 'Model', deviceProfile.model.trim().length > 0],
    ['wavelengthsNm', 'Wavelengths', deviceProfile.wavelengthsNm.length > 0],
    ['measurementType', 'Measurement type', Boolean(deviceProfile.measurementType)],
    ['units', 'Units', deviceProfile.units.trim().length > 0],
    [
      'samplingFrequencyHz',
      'Sampling frequency',
      deviceProfile.samplingFrequencyHz != null
        && Number.isFinite(deviceProfile.samplingFrequencyHz)
        && deviceProfile.samplingFrequencyHz > 0,
    ],
  ];

  return fields
    .filter(([, , complete]) => !complete)
    .map(([key, label]) => ({ key, label }));
}
