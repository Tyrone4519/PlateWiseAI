export function goToPage(page) {
  window.location.href = page;
}

export function redirectIfNoSession(session) {
  if (!session?.user) {
    window.location.href = 'index.html';
    return true;
  }
  return false;
}
