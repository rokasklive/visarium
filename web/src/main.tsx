import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { reportErrorsToDesktop } from '~/api/desktop';
import { AppProviders } from '~/app/providers';
import { followSystemTheme } from '~/app/theme';
import './styles/app.css';

// No browser context menu over the app; a menu of its own comes later. Text
// fields keep theirs, for paste and spelling.
document.addEventListener('contextmenu', (event) => {
  const field =
    event.target instanceof Element &&
    event.target.closest('input, textarea, [contenteditable="true"]');
  if (!field) event.preventDefault();
});

reportErrorsToDesktop();
followSystemTheme();

const container = document.getElementById('root');
if (!container) throw new Error('#root missing from index.html');

createRoot(container).render(
  <StrictMode>
    <AppProviders />
  </StrictMode>,
);
