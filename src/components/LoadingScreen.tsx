import { useState } from 'react';

import { pickChessFact } from '../content/chess-facts.js';

export function LoadingScreen({ message }: { message: string }) {
  const [fact] = useState(() => pickChessFact());
  return <main className="loading-screen" aria-busy="true" aria-live="polite">
    <span className="loading-mark" aria-hidden="true">♜</span>
    <div className="loading-copy">
      <p>{message}</p>
      <aside aria-label="Chess fact"><small>While you wait</small><strong>{fact}</strong></aside>
    </div>
  </main>;
}
