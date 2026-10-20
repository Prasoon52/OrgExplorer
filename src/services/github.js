// IndexedDB Cache (L2)
const DB_NAME = 'orgexplorer_cache'
const STORE = 'cache'
const TTL_MS = 3_600_000 // 1 hour

/**
 * Canonicalize an API URL into a deterministic cache key.
 *
 * GitHub treats org and repo names case-insensitively, but the raw URL
 * string does not — `.../orgs/AOSSIE-Org` and `.../orgs/aossie-org` would
 * otherwise become two separate entries, and a re-search in a different
 * case would burn rate-limit quota on data we already hold.
 *
 * Only the pathname is lowercased; query values are left untouched (they
 * can be case-sensitive, e.g. search qualifiers) while parameter order is
 * normalized so equivalent URLs share one key. The request URL itself is
 * never rewritten — this applies to the cache key only.
 */
export function normalizeCacheKey(url) {
  try {
    const u = new URL(url)
    u.pathname = (u.pathname.replace(/\/+$/, '') || '/').toLowerCase()
    u.searchParams.sort()
    return u.toString()
  } catch {
    return url
  }
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = e => e.target.result.createObjectStore(STORE, { keyPath: 'k' })
    req.onsuccess = e => resolve(e.target.result)
    req.onerror = () => reject(req.error)
  })
}

export async function cacheGet(key) {
  try {
    const db = await openDB()
    return new Promise(res => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(normalizeCacheKey(key))
      req.onsuccess = () => {
        const r = req.result
        if (!r || Date.now() - r.ts > TTL_MS) return res(null)
        res(r.v)
      }
      req.onerror = () => res(null)
    })
  } catch { return null }
}

export async function cacheSet(key, value) {
  try {
    const db = await openDB()
    return new Promise(res => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put({ k: normalizeCacheKey(key), v: value, ts: Date.now() })
      tx.oncomplete = () => res(true)
      tx.onerror = () => res(false)
    })
  } catch { return false }
}

export async function cacheClear() {
  try {
    const db = await openDB()
    return new Promise(res => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).clear()
      tx.oncomplete = () => res(true)
      tx.onerror = () => res(false)
    })
  } catch { return false }
}

// Shared GitHub request: sends the request, broadcasts rate-limit headers and
// maps error statuses to the categories the rest of the app expects.
// Returns the Response so callers can read the body or the headers.
async function githubRequest(url, pat) {
  const headers = { Accept: 'application/vnd.github.v3+json' }
  if (pat) headers.Authorization = `token ${pat}`

  const res = await fetch(url, { headers })

  window.dispatchEvent(
    new CustomEvent('rate-limit-update', {
      detail: {
        limit: Number(res.headers.get('x-ratelimit-limit')),
        remaining: Number(res.headers.get('x-ratelimit-remaining')),
        used: Number(res.headers.get('x-ratelimit-used')),
        reset: Number(res.headers.get('x-ratelimit-reset'))
      }
    })
  )

  if (res.status === 429) throw new Error('RATE_LIMIT')
  if (res.status === 403) {
    const remaining = res.headers?.get ? res.headers.get('x-ratelimit-remaining') : null
    const retryAfter = res.headers?.get ? res.headers.get('retry-after') : null

    if (remaining === '0' || retryAfter) {
      throw new Error('RATE_LIMIT')
    }

    try {
      const cloned = typeof res.clone === 'function' ? res.clone() : res
      const body = await cloned.json()
      const msg = typeof body?.message === 'string' ? body.message.toLowerCase() : ''
      if (msg.includes('rate limit') || msg.includes('secondary rate') || msg.includes('abuse detection')) {
        throw new Error('RATE_LIMIT')
      }
    } catch (e) {
      if (e.message === 'RATE_LIMIT') throw e
    }

    throw new Error('HTTP_403')
  }
  if (res.status === 404) throw new Error('NOT_FOUND')

  return res
}

// Core fetchWithCache
async function fetchWithCache(url, pat) {
  // L2 check
  const cached = await cacheGet(url)
  if (cached) return cached

  const res = await githubRequest(url, pat)

  if (res.status === 204 || res.status === 409) {
    // Empty repository (e.g. contributors on a repo with no commits):
    // GitHub answers with no JSON body, so res.json() below would throw
    // and the failure would never be cached — every re-search would spend
    // another token on the same URL. Cache the empty result instead.
    // All list-endpoint callers treat [] as "no data", and analytics
    // already defaults missing entries to [].
    const empty = []
    cacheSet(url, empty) // write-back, non-blocking
    return empty
  }

  if (!res.ok) throw new Error(`HTTP_${res.status}`)

  const data = await res.json()
  cacheSet(url, data) // write-back, non-blocking
  return data
}

/**
 * Read the page number of the rel="last" link from a GitHub `Link` header.
 * Returns null when the header is missing or has no "last" link
 * (i.e. all results fit on the first page).
 */
export function parseLastPage(linkHeader) {
  if (typeof linkHeader !== 'string') return null
  const last = linkHeader.split(',').find(part => /rel="last"/.test(part))
  const match = last && last.match(/[?&]page=(\d+)/)
  return match ? Number(match[1]) : null
}

// Public service functions
export const fetchOrg = (org, pat) =>
  fetchWithCache(`https://api.github.com/orgs/${org}`, pat)

export async function fetchRepos(org, repoCount, pat) {
  const all = []
  const maxPages = pat ? Math.ceil(repoCount / 100) : 5
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://api.github.com/orgs/${org}/repos?per_page=100&page=${page}&sort=updated`
    const data = await fetchWithCache(url, pat)
    all.push(...data)
    if (data.length < 100) break
  }
  return all
}

export async function fetchContributors(org, repo, pat) {
  const all = []
  const maxPages = pat ? 10 : 1
  for(let page = 1; page<=maxPages ; page++) {
    const url = `https://api.github.com/repos/${org}/${repo}/contributors?per_page=100&page=${page}`
    const data = await fetchWithCache(url, pat)
    all.push(...data)
    if(data.length < 100) break
  }
  return all
}

export async function fetchIssues(org, repo, pat) {
  const all = []
  const maxPages = pat ? 10 : 1
  for(let page = 1; page<=maxPages ; page++) {
    const url = `https://api.github.com/repos/${org}/${repo}/issues?state=all&per_page=100&page=${page}`
    const data = await fetchWithCache(url, pat)
    all.push(...data)
    if(data.length < 100) break
  }
  return all
}

export async function fetchPulls(org, repo, pat) {
  const all = []
  const maxPages = pat ? 10 : 1
  for(let page = 1; page<=maxPages ; page++) {
    const url = `https://api.github.com/repos/${org}/${repo}/pulls?state=all&per_page=100&page=${page}`
    const data = await fetchWithCache(url, pat)
    all.push(...data)
    if(data.length < 100) break
  }
  return all
}

/**
 * Count the open pull requests of a repository with a single request.
 *
 * GitHub's `open_issues_count` on a repository includes open pull requests,
 * so this count is needed to separate real issues from PRs. With
 * `per_page=1`, the `Link` header's rel="last" page number equals the total
 * number of open PRs, so no PR data has to be downloaded.
 *
 * The count is cached for the same TTL as every other response. It uses its
 * own cache key because the cached value is a number, not the response body.
 */
export async function fetchOpenPullCount(org, repo, pat) {
  const url = `https://api.github.com/repos/${org}/${repo}/pulls?state=open&per_page=1`
  const cacheKey = `${url}&oe_count=1`

  const cached = await cacheGet(cacheKey)
  if (typeof cached === 'number') return cached

  const res = await githubRequest(url, pat)
  let count = 0
  if (res.ok && res.status !== 204) {
    const lastPage = parseLastPage(res.headers.get('link'))
    if (lastPage !== null) {
      count = lastPage
    } else {
      const data = await res.json()
      count = Array.isArray(data) ? data.length : 0
    }
  } else if (!res.ok && res.status !== 409) {
    throw new Error(`HTTP_${res.status}`)
  }

  cacheSet(cacheKey, count) // write-back, non-blocking
  return count
}

export async function fetchRateLimit(pat) {
  try {
    const headers = { Accept: 'application/vnd.github.v3+json' }
    if (pat) headers.Authorization = `token ${pat}`
    const res = await fetch('https://api.github.com/rate_limit', { headers })
    const data = await res.json()
    return data.rate
  } catch { return null }
}
