import { describe, expect, it, vi } from 'vitest';
import { updateTransmissionDepth } from './transmissionDepth';

describe('transmission depth slider scope', () => {
  it('updates the project default when no channel is selected', () => {
    const actions = { setDefaultDepth: vi.fn(), setPairDepthOverride: vi.fn() };
    updateTransmissionDepth(null, null, 31, actions);
    expect(actions.setDefaultDepth).toHaveBeenCalledWith(31);
    expect(actions.setPairDepthOverride).not.toHaveBeenCalled();
  });

  it('updates only the selected instance and pair when a channel is selected', () => {
    const actions = { setDefaultDepth: vi.fn(), setPairDepthOverride: vi.fn() };
    updateTransmissionDepth('instance-a', 'pair-a', 37, actions);
    expect(actions.setPairDepthOverride).toHaveBeenCalledWith('instance-a', 'pair-a', 37);
    expect(actions.setDefaultDepth).not.toHaveBeenCalled();
  });
});
