import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.js';
import './styles.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('App root #root is missing.');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
      scope: import.meta.env.BASE_URL,
    });
  });
}
