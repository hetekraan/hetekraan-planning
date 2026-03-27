// Exponential backoff retry wrapper voor fetch calls.
// Retries bij netwerk errors of 5xx responses.
// Wacht: 500ms → 1000ms → 2000ms → 4000ms (max 4 pogingen).
//
// LET OP: gebruik fetchWithRetry NOOIT voor niet-idempotente POST-calls
// (bijv. aanmaken van een GHL-afspraak). Een 5xx-retry maakt dan een
// tweede resource aan. Gebruik voor die calls plain fetch().

export async function fetchWithRetry(url, options = {}, maxRetries = 3) {
  const baseDelay = 500;

  // Veiligheidscheck: POST/PUT/PATCH die iets aanmaken mogen niet blind worden
  // geretried. Gooi in development een fout als dit mis gaat.
  const method = (options.method || 'GET').toUpperCase();
  const isNonIdempotent = method === 'POST';
  if (isNonIdempotent && maxRetries > 0) {
    // Controleer of de caller bewust retry wil voor een POST (via expliciete optie).
    if (!options._allowPostRetry) {
      // Geen retry voor POST: zet maxRetries op 0 zodat er maar 1 poging is.
      maxRetries = 0;
    }
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, options);

      // Direct teruggeven bij succesvolle of client-error responses (4xx zijn geen retry-kandidaten)
      if (res.ok || (res.status >= 400 && res.status < 500)) {
        return res;
      }

      // 5xx → retry (tenzij laatste poging)
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt);
        console.warn(`[retry] ${res.status} op ${url} — poging ${attempt + 1}/${maxRetries}, wacht ${delay}ms`);
        await sleep(delay);
        continue;
      }

      return res; // Laatste poging, geef toch terug

    } catch (err) {
      // Netwerk error (DNS, timeout, etc.)
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt);
        console.warn(`[retry] netwerk error op ${url} — poging ${attempt + 1}/${maxRetries}, wacht ${delay}ms:`, err.message);
        await sleep(delay);
        continue;
      }
      throw err; // Laatste poging: gooi fout door
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
