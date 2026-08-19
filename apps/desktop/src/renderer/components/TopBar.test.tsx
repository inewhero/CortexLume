// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TopBar } from './TopBar';

afterEach(cleanup);
beforeEach(() => {
  Object.defineProperty(window, 'cortexlume', {
    configurable: true,
    value: { window: { minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn() } },
  });
});

describe('TopBar update indicator', () => {
  it('shows only a verified available update and opens it on click', () => {
    const onOpenUpdate = vi.fn();
    const { rerender } = render(<TopBar update={null} onOpenUpdate={onOpenUpdate} />);
    expect(screen.queryByText(/UPDATE AVAILABLE/)).not.toBeInTheDocument();
    rerender(<TopBar update={{
      status: 'available', currentVersion: '1.2.0', latestVersion: '1.3.0',
      releaseUrl: 'https://github.com/inewhero/CortexLume/releases/tag/v1.3.0',
    }} onOpenUpdate={onOpenUpdate} />);
    fireEvent.click(screen.getByRole('button', { name: 'UPDATE AVAILABLE · v1.3.0' }));
    expect(onOpenUpdate).toHaveBeenCalledOnce();
  });
});
