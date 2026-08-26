import { describe, expect, it } from 'vitest';
import { isAllowedDevNavigation } from './navigationPolicy';

describe('development navigation policy', () => {
  const devServer = 'http://localhost:5173';

  it('allows the configured origin and nested development routes', () => {
    expect(isAllowedDevNavigation(devServer, devServer)).toBe(true);
    expect(isAllowedDevNavigation('http://localhost:5173/foo', devServer)).toBe(true);
    expect(isAllowedDevNavigation('http://localhost:5173/foo?project=1#details', devServer)).toBe(true);
  });

  it('requires an exact origin instead of a string prefix', () => {
    expect(isAllowedDevNavigation('http://localhost:51730/foo', devServer)).toBe(false);
    expect(isAllowedDevNavigation('http://localhost.evil.test:5173/foo', devServer)).toBe(false);
    expect(isAllowedDevNavigation('https://localhost:5173/foo', devServer)).toBe(false);
  });

  it('keeps navigation below a configured base pathname', () => {
    const base = 'http://localhost:5173/app';
    expect(isAllowedDevNavigation('http://localhost:5173/app', base)).toBe(true);
    expect(isAllowedDevNavigation('http://localhost:5173/app/routes/project', base)).toBe(true);
    expect(isAllowedDevNavigation('http://localhost:5173/application', base)).toBe(false);
    expect(isAllowedDevNavigation('http://localhost:5173/other', base)).toBe(false);
    expect(isAllowedDevNavigation('http://localhost:5173/app', `${base}/`)).toBe(true);
  });

  it('fails closed for malformed URLs, credentials and production', () => {
    expect(isAllowedDevNavigation('not a URL', devServer)).toBe(false);
    expect(isAllowedDevNavigation('http://user:secret@localhost:5173/foo', devServer)).toBe(false);
    expect(isAllowedDevNavigation('http://localhost:5173/foo')).toBe(false);
  });
});
