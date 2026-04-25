export function $(id) {
  return document.getElementById(id);
}

export function escapeHtml(text = '') {
  const div = document.createElement('div');
  div.textContent = String(text);
  return div.innerHTML;
}

export function stripHtml(html = '') {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent || div.innerText || '';
}

export function formatDateTime(dateLike) {
  if (!dateLike) return '-';
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleString();
}

export function formatDate(dateLike) {
  if (!dateLike) return '-';
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleDateString();
}

export function showToast(message, isError = false) {
  const toast = document.createElement('div');
  toast.className = `toast ${isError ? 'toast-error' : 'toast-success'}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 250);
  }, 2400);
}

export function getRiskClass(risk) {
  switch ((risk || '').toLowerCase()) {
    case 'high':
      return 'danger-text';
    case 'medium':
      return 'warning-text';
    case 'low':
      return 'success-text';
    default:
      return '';
  }
}
