export async function authRequest(action, fields = {}) {
  let response;
  try {
    response = await fetch('/api/auth', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...fields }),
    });
  } catch { throw new Error('Unable to connect. Check your connection and try again.'); }
  let result;
  try { result = await response.json(); }
  catch { throw new Error('Authentication service returned an unexpected response. Reload this Preview and try again.'); }
  if (!response.ok) {
    const error = new Error(result.error || 'Request failed.');
    error.status = response.status;
    throw error;
  }
  return result;
}
