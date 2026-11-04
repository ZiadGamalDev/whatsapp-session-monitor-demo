import { describe, expect, it } from 'vitest';
import { composerMode, messageLink } from '../web/src/logic.js';

describe('dashboard rules', () => {
  it('links Cloud API messages to the inbox thread, fleet messages to their session', () => {
    expect(messageLink({ source: 'cloud', sessionId: 'cloud', to: '+999 7100 0003' })).toBe('#/inbox/99971000003');
    expect(messageLink({ source: 'synthetic', sessionId: 's11', to: '+999 7000 0570' })).toBe('#/sessions/s11');
    expect(messageLink({ source: 'api', sessionId: 's02', to: '+999 0000 0001' })).toBe('#/sessions/s02');
  });

  it('never offers free-form text while the 24 h window is closed', () => {
    expect(composerMode(true, 'text')).toBe('text');
    expect(composerMode(true, 'template')).toBe('template');
    expect(composerMode(false, 'text')).toBe('template');
    expect(composerMode(false, 'template')).toBe('template');
  });
});
