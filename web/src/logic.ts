/** Small UI rules kept free of Vue so they can be unit-tested. */

/** Where a message row should link: fleet messages to their session, Cloud API messages to the inbox thread. */
export function messageLink(m: { source: string; sessionId: string; to: string }): string {
  if (m.source === 'cloud') {
    const waId = m.to.replace(/\D/g, '');
    return `#/inbox/${waId}`;
  }
  return `#/sessions/${m.sessionId}`;
}

export type ComposerMode = 'text' | 'template';

/** Free-form text is only possible while the 24 h window is open. */
export function composerMode(windowOpen: boolean, requested: ComposerMode): ComposerMode {
  return windowOpen ? requested : 'template';
}
