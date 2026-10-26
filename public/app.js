// Small page helpers: confirm buttons, select-all and selected count.
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-confirm]');
  if (b && !confirm(b.getAttribute('data-confirm'))) e.preventDefault();
});
const all = document.querySelector('[data-check-all]');
const count = document.querySelector('[data-selected-count]');
const boxes = () => Array.from(document.querySelectorAll('input[name="ids"][form="bulk"]'));
function updateCount() {
  if (!count) return;
  const n = boxes().filter(b => b.checked).length;
  count.textContent = n + ' selected';
  count.closest('form').classList.toggle('has', n > 0);
}
if (all) all.addEventListener('change', () => { boxes().forEach(b => (b.checked = all.checked)); updateCount(); });
document.addEventListener('change', (e) => { if (e.target.matches('input[name="ids"]')) updateCount(); });
updateCount();
