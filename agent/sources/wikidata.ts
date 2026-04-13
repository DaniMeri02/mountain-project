import type { AgentInput, SourceResult, WikidataRow, WikidataSparqlResponse } from '../types';

const ENDPOINT = 'https://query.wikidata.org/sparql';

/** Escape a string to be safely embedded in a SPARQL string literal. */
function sparqlEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function formatRow(row: WikidataRow): string {
  const parts: string[] = [];

  if (row.description?.value) {
    parts.push(`Descrizione: ${row.description.value}`);
  }
  if (row.elevation?.value) {
    parts.push(`Altitudine (Wikidata): ${Math.round(Number(row.elevation.value))}m s.l.m.`);
  }
  if (row.inception?.value) {
    const year = new Date(row.inception.value).getFullYear();
    if (!isNaN(year)) parts.push(`Anno di costruzione/inaugurazione: ${year}`);
  }
  if (row.website?.value) {
    parts.push(`Sito ufficiale: ${row.website.value}`);
  }
  if (row.wikipedia?.value) {
    parts.push(`Pagina Wikipedia: ${row.wikipedia.value}`);
  }

  return parts.join('\n');
}

/** Build a SPARQL SELECT body with optional/wikipedia blocks (reused in both queries) */
function buildSelectBody(): string {
  return `
      OPTIONAL { ?item schema:description ?description . FILTER(LANG(?description) = "it") }
      OPTIONAL { ?item wdt:P2044 ?elevation }
      OPTIONAL {
        ?article schema:about ?item ;
                 schema:inLanguage "it" ;
                 schema:isPartOf <https://it.wikipedia.org/> .
        BIND(STR(?article) AS ?wikipedia)
      }
      OPTIONAL { ?item wdt:P856 ?website }
      OPTIONAL { ?item wdt:P571 ?inception }
      SERVICE wikibase:label { bd:serviceParam wikibase:language "it,en" }
  `;
}

export async function fetchWikidata(input: AgentInput): Promise<SourceResult> {
  const safe = sparqlEscape(input.name);

  // Primary: exact Italian label match
  const query = `
    SELECT DISTINCT ?item ?itemLabel ?description ?elevation ?wikipedia ?website ?inception WHERE {
      { ?item rdfs:label "${safe}"@it . }
      UNION
      { ?item skos:altLabel "${safe}"@it . }
      ${buildSelectBody()}
    }
    LIMIT 3
  `;

  try {
    const url = `${ENDPOINT}?query=${encodeURIComponent(query)}&format=json`;
    const response = await fetch(url, {
      headers: {
        Accept: 'application/sparql-results+json',
        'User-Agent': 'MountainPortal/1.0 (personal project; contact: localhost)',
      },
      signal: AbortSignal.timeout(12_000),
    });

    if (!response.ok) {
      return { sourceName: 'Wikidata', content: '', success: false };
    }

    const data = (await response.json()) as WikidataSparqlResponse;
    const bindings = data.results?.bindings ?? [];

    const formatted = bindings
      .map(formatRow)
      .filter((s) => s.length > 0)
      .join('\n---\n');

    if (formatted) {
      const itemUrl = bindings[0]?.item?.value;
      return { sourceName: 'Wikidata', content: formatted, success: true, url: itemUrl };
    }

    // Fallback: coordinate-based search within 1km when lat/lng available
    if (input.lat == null || input.lng == null) {
      return { sourceName: 'Wikidata', content: '', success: false };
    }

    const coordQuery = `
      SELECT DISTINCT ?item ?itemLabel ?description ?elevation ?wikipedia ?website ?inception WHERE {
        SERVICE wikibase:around {
          ?item wdt:P625 ?coord .
          bd:serviceParam wikibase:center "Point(${input.lng} ${input.lat})"^^geo:wktLiteral .
          bd:serviceParam wikibase:radius "1" .
        }
        ${buildSelectBody()}
      }
      LIMIT 3
    `;

    const coordUrl = `${ENDPOINT}?query=${encodeURIComponent(coordQuery)}&format=json`;
    const coordRes = await fetch(coordUrl, {
      headers: {
        Accept: 'application/sparql-results+json',
        'User-Agent': 'MountainPortal/1.0 (personal project; contact: localhost)',
      },
      signal: AbortSignal.timeout(12_000),
    });

    if (!coordRes.ok) {
      return { sourceName: 'Wikidata', content: '', success: false };
    }

    const coordData = (await coordRes.json()) as WikidataSparqlResponse;
    const coordFormatted = (coordData.results?.bindings ?? [])
      .map(formatRow)
      .filter((s) => s.length > 0)
      .join('\n---\n');

    if (!coordFormatted) {
      return { sourceName: 'Wikidata', content: '', success: false };
    }

    const coordItemUrl = coordData.results?.bindings[0]?.item?.value;
    return { sourceName: 'Wikidata (coordinate)', content: coordFormatted, success: true, url: coordItemUrl };
  } catch {
    return { sourceName: 'Wikidata', content: '', success: false };
  }
}
