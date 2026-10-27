// Author, creator and maintainer: Dhruba Poudel.
import { createRoot } from 'react-dom/client';

const root = document.getElementById('root');
if (!root) throw new Error('The application root was not found.');
async function start() {
  if (window.location.pathname === '/classic' || window.location.pathname === '/classic/') {
    document.title = 'Exception Studio Classic — Dhruba Poudel';
    const [{ App }] = await Promise.all([import('./App'), import('./styles.css')]);
    createRoot(root!).render(<App />);
  } else {
    const { default: TeamApp } = await import('./team/TeamApp');
    createRoot(root!).render(<TeamApp />);
  }
}
void start().catch(() => {
  root.textContent = 'Exception Studio could not load. Please reload the page to try again.';
});
