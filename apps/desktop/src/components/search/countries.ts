/**
 * A static, complete list of countries for the worldwide-market country filter — not derived from
 * scan results, not a curated shortlist of "major" markets. The worldwide pipeline's sources are
 * genuinely unbounded (see docs/job-source-policy.md); a vacancy from any country is possible, so
 * the filter options must cover every country regardless of whether one has ever shown up yet.
 *
 * Filtering itself happens over each vacancy's own free-text `location` field (see
 * `normalizeCountry` below) — the list here is only the set of selectable options.
 */
export const ALL_COUNTRIES: readonly string[] = [
  'Afghanistan', 'Albania', 'Algeria', 'Andorra', 'Angola', 'Antigua and Barbuda', 'Argentina',
  'Armenia', 'Australia', 'Austria', 'Azerbaijan', 'Bahamas', 'Bahrain', 'Bangladesh', 'Barbados',
  'Belarus', 'Belgium', 'Belize', 'Benin', 'Bhutan', 'Bolivia', 'Bosnia and Herzegovina', 'Botswana',
  'Brazil', 'Brunei', 'Bulgaria', 'Burkina Faso', 'Burundi', 'Cabo Verde', 'Cambodia', 'Cameroon',
  'Canada', 'Central African Republic', 'Chad', 'Chile', 'China', 'Colombia', 'Comoros',
  'Congo', 'Costa Rica', 'Croatia', 'Cuba', 'Cyprus', 'Czechia',
  'Democratic Republic of the Congo', 'Denmark', 'Djibouti', 'Dominica',
  'Dominican Republic', 'Ecuador', 'Egypt', 'El Salvador', 'Equatorial Guinea', 'Eritrea', 'Estonia',
  'Eswatini', 'Ethiopia', 'Fiji', 'Finland', 'France', 'Gabon', 'Gambia', 'Georgia', 'Germany',
  'Ghana', 'Greece', 'Grenada', 'Guatemala', 'Guinea', 'Guinea-Bissau', 'Guyana', 'Haiti', 'Honduras',
  'Hungary', 'Iceland', 'India', 'Indonesia', 'Iran', 'Iraq', 'Ireland', 'Israel', 'Italy',
  'Ivory Coast', 'Jamaica',
  'Japan', 'Jordan', 'Kazakhstan', 'Kenya', 'Kiribati', 'Kosovo', 'Kuwait', 'Kyrgyzstan', 'Laos',
  'Latvia', 'Lebanon', 'Lesotho', 'Liberia', 'Libya', 'Liechtenstein', 'Lithuania', 'Luxembourg',
  'Madagascar', 'Malawi', 'Malaysia', 'Maldives', 'Mali', 'Malta', 'Marshall Islands', 'Mauritania',
  'Mauritius', 'Mexico', 'Micronesia', 'Moldova', 'Monaco', 'Mongolia', 'Montenegro', 'Morocco',
  'Mozambique', 'Myanmar', 'Namibia', 'Nauru', 'Nepal', 'Netherlands', 'New Zealand', 'Nicaragua',
  'Niger', 'Nigeria', 'North Korea', 'North Macedonia', 'Norway', 'Oman', 'Pakistan', 'Palau',
  'Palestine', 'Panama', 'Papua New Guinea', 'Paraguay', 'Peru', 'Philippines', 'Poland', 'Portugal',
  'Qatar', 'Romania', 'Russia', 'Rwanda', 'Saint Kitts and Nevis', 'Saint Lucia',
  'Saint Vincent and the Grenadines', 'Samoa', 'San Marino', 'Sao Tome and Principe', 'Saudi Arabia',
  'Senegal', 'Serbia', 'Seychelles', 'Sierra Leone', 'Singapore', 'Slovakia', 'Slovenia',
  'Solomon Islands', 'Somalia', 'South Africa', 'South Korea', 'South Sudan', 'Spain', 'Sri Lanka',
  'Sudan', 'Suriname', 'Sweden', 'Switzerland', 'Syria', 'Taiwan', 'Tajikistan', 'Tanzania',
  'Thailand', 'Timor-Leste', 'Togo', 'Tonga', 'Trinidad and Tobago', 'Tunisia', 'Turkey',
  'Turkmenistan', 'Tuvalu', 'Uganda', 'Ukraine', 'United Arab Emirates', 'United Kingdom',
  'United States', 'Uruguay', 'Uzbekistan', 'Vanuatu', 'Vatican City', 'Venezuela', 'Vietnam',
  'Yemen', 'Zambia', 'Zimbabwe',
];

/**
 * Common English-language aliases/abbreviations for countries that vacancy listings routinely use
 * instead of the full name (e.g. "Remote - US", "UK only"). Keys are lowercase; values are the
 * canonical name as it appears in `ALL_COUNTRIES`. Deliberately conservative: an alias is only
 * listed here when it's unambiguous. Anything not covered by a country name or an alias here falls
 * into "Unspecified location" rather than being guessed.
 */
const COUNTRY_ALIASES: Readonly<Record<string, string>> = {
  usa: 'United States',
  'u.s.a.': 'United States',
  'u.s.': 'United States',
  us: 'United States',
  'united states of america': 'United States',
  uk: 'United Kingdom',
  'u.k.': 'United Kingdom',
  'great britain': 'United Kingdom',
  britain: 'United Kingdom',
  england: 'United Kingdom',
  scotland: 'United Kingdom',
  wales: 'United Kingdom',
  uae: 'United Arab Emirates',
  'republic of korea': 'South Korea',
  korea: 'South Korea',
  holland: 'Netherlands',
  'czech republic': 'Czechia',
  "cote d'ivoire": 'Ivory Coast',
  'drc': 'Democratic Republic of the Congo',
  'congo-kinshasa': 'Democratic Republic of the Congo',
  'congo-brazzaville': 'Congo',
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Sorted longest-first so e.g. "United Arab Emirates" matches before a shorter unrelated prefix.
 * Each regex is compiled once here, at module load, rather than inside `normalizeCountry` on every
 * call: this list is checked against every vacancy's location on every filter-bar keystroke (any
 * filter change re-runs the whole result set, not just a country change), and re-compiling ~200
 * regexes per vacancy per keystroke measured in the hundreds of milliseconds on a worldwide
 * report's typical vacancy count — long enough to visibly stall typing.
 */
const MATCH_TERMS: readonly { pattern: RegExp; country: string }[] = [
  ...ALL_COUNTRIES.map((country) => ({ term: country.toLowerCase(), country })),
  ...Object.entries(COUNTRY_ALIASES).map(([alias, country]) => ({ term: alias, country })),
]
  .sort((a, b) => b.term.length - a.term.length)
  .map(({ term, country }) => ({
    pattern: new RegExp(`(?:^|[^a-z])${escapeRegExp(term)}(?:$|[^a-z])`, 'u'),
    country,
  }));

/** Memoized by raw location text: many vacancies in one report repeat the same location string. */
const normalizeCache = new Map<string, string | null>();

/**
 * Matches a country name/alias as a whole word within free-text location, so "Ireland" doesn't
 * false-positive inside "Irelandville" and "US" doesn't match inside "Business". Returns the
 * canonical `ALL_COUNTRIES` name, or `null` when nothing matches confidently — the caller renders
 * that as "Unspecified location" rather than guessing.
 */
export function normalizeCountry(location: string | null | undefined): string | null {
  if (!location) return null;
  const cached = normalizeCache.get(location);
  if (cached !== undefined) return cached;
  const haystack = location.toLowerCase();
  let result: string | null = null;
  for (const { pattern, country } of MATCH_TERMS) {
    if (pattern.test(haystack)) {
      result = country;
      break;
    }
  }
  normalizeCache.set(location, result);
  return result;
}

export const UNSPECIFIED_LOCATION = 'Unspecified location';
