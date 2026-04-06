/**
 * Factory for HubSpot serverless function context and sendResponse mocks.
 */
export function makeContext({ email, body = {}, contact } = {}) {
  return {
    body,
    contact: contact !== undefined
      ? contact
      : email ? { email } : null,
  };
}

export function makeSendResponse() {
  const calls = [];
  const fn = (response) => calls.push(response);
  fn.calls = calls;
  fn.lastCall = () => calls[calls.length - 1];
  fn.reset = () => { calls.length = 0; };
  return fn;
}
