import { normalizeVacancyText } from '../vacancies/hash.js';

/**
 * The recruiting-template vocabulary that a job advert shares with every other job advert.
 *
 * Why this file exists (issue #139 follow-up). The cross-company duplicate heuristic scored two
 * postings by the Jaccard overlap of their raw description tokens. That measure cannot tell the
 * difference between "these two adverts describe the same job" and "these two adverts were typed
 * into the same applicant-tracking system". Modern ATS products ship a default job-description
 * skeleton, and recruiters routinely keep it: the equal-opportunity paragraph, the benefits
 * paragraph, "3+ years of experience", "strong communication skills", "fast paced environment",
 * "we look forward to receiving your application". Two employers with nothing to do with each other
 * can therefore share 80% of their vocabulary while sharing none of their *job*.
 *
 * An adversarial review of the shipped v1 demonstrated exactly that with two real, unrelated
 * companies -- a US IT-staffing firm and a Bermuda fund administrator, both with an Amsterdam
 * office, both posting a genuinely different "Software Engineer" role on the same template. The raw
 * Jaccard was 0.82, comfortably over the 0.65 grouping threshold and within a whisker of the
 * module's own genuine-repost fixture at 0.89. The two populations the threshold was supposed to
 * separate had collapsed into each other.
 *
 * So the comparison is taken over *substantive* tokens only: everything below is subtracted from
 * both sides first, leaving the stack, the domain, the product and the responsibilities -- the words
 * that actually say which job this is. Subtraction is symmetric and content-free: it removes the
 * same language from every posting regardless of employer, sector or country, so it cannot express a
 * preference for any role, market or salary band.
 *
 * ## Still needed after the v3 rewrite, for a different reason
 *
 * `cross-company-duplicates.ts` no longer compares token *sets* at all -- a second review showed
 * that measure could not separate a repost from two adverts about the same stack, and it was
 * replaced by word-shingle overlap. This file survived that rewrite because the problem it solves is
 * upstream of whichever measure runs: the round-1 Apex pair shares an entire unedited ATS skeleton
 * *verbatim*, so it shares that skeleton's five-word runs as readily as its vocabulary. Stripping
 * the template first is what drops that pair from 0.82 to 0.07. The output consumed downstream is
 * now `substantiveDescriptionTokenSequence`, which keeps word order, because order is precisely the
 * signal the new measure runs on.
 *
 * Everything here is a fixed local table. Nothing in this file consults a model, a service or the
 * network.
 */

/**
 * Multi-word template language, matched as a token subsequence and removed whole.
 *
 * Phrases are here rather than in the single-token list when their words are individually
 * meaningful: "track record" has to go, but "record" on its own may be the thing the job is about.
 * Longest match at a position wins, so a specific phrase can safely sit alongside the general one
 * it extends.
 *
 * Written in ordinary English and tokenized through the same pipeline as a real description, so an
 * apostrophe or a hyphen here behaves exactly as it does in a posting ("bachelor's degree" and
 * "bachelors degree" both reduce to the same token run as the entry below).
 */
const BOILERPLATE_PHRASES: readonly string[] = [
  // Openers and section headings.
  'about us',
  'about the role',
  'about the team',
  'about the company',
  'about the job',
  'about you',
  'the role',
  'your role',
  'the opportunity',
  'the position',
  'job description',
  'job summary',
  'job purpose',
  'role overview',
  'position overview',
  'role description',
  'who we are',
  'who you are',
  'what you will do',
  'what you will be doing',
  'what you ll do',
  'what you will bring',
  'what you bring',
  'what we offer',
  'what we are looking for',
  'what you can expect',
  'what is in it for you',
  'why join us',
  'why work with us',
  'your profile',
  'your responsibilities',
  'your impact',
  'key responsibilities',
  'main responsibilities',
  'core responsibilities',
  'duties and responsibilities',
  'roles and responsibilities',
  'responsibilities include',
  'requirements',
  'minimum requirements',
  'basic qualifications',
  'minimum qualifications',
  'preferred qualifications',
  'desired qualifications',
  'skills and experience',
  'skills and qualifications',
  'nice to have',
  'nice to haves',
  'good to have',
  'must have',
  'must haves',
  'bonus points',
  'bonus points for',

  // The "we are hiring" opener in its usual variants.
  'we are looking for',
  'we are currently looking for',
  'we are seeking',
  'we are currently seeking',
  'we are hiring',
  'we are on the lookout for',
  'are you the',
  'do you want to',
  'we are looking for a talented',
  'we are looking for an experienced',
  'join our growing team',
  'join our team',
  'join us',
  'become part of our team',
  'be part of our team',
  'part of our team',
  'you will join',
  'you will be joining',
  'to join our',
  'to strengthen our team',
  'our growing team',
  'a talented',
  'an experienced',
  'an enthusiastic',
  'a motivated',
  'a passionate',

  // Responsibility scaffolding.
  'you will be responsible for',
  'you are responsible for',
  'will be responsible for',
  'responsible for',
  'you will work closely with',
  'work closely with',
  'working closely with',
  'you will collaborate with',
  'collaborate with',
  'in close collaboration with',
  'cross functional teams',
  'cross functional team',
  'cross functionally',
  'multi disciplinary team',
  'multidisciplinary team',
  'you will report to',
  'reporting to the',
  'report to the',
  'day to day',
  'on a daily basis',
  'high quality software solutions',
  'high quality software',
  'high quality solutions',
  'designing developing and maintaining',
  'design develop and maintain',
  'developing and maintaining',
  'design and develop',
  'build and maintain',
  'end to end ownership',
  'take ownership of',
  'drive the',
  'help us build',
  'help us to build',
  'contribute to the',
  'on time and to a high standard',
  'on time and within budget',
  'deliver features',
  'deliver high quality',
  'to a high standard',
  'ensure that',
  'make sure that',
  'in line with',
  'best practices',
  'industry best practices',
  'coding standards',
  'code reviews',
  'continuous improvement',
  'make an impact',
  'make a real impact',
  'have a real impact',
  'making an impact',

  // Experience and qualification requirements.
  'years of experience',
  'years experience',
  'years of professional experience',
  'years of relevant experience',
  'years of hands on experience',
  'years of work experience',
  'years of commercial experience',
  'years of industry experience',
  'or more years of experience',
  'at least years of experience',
  'minimum of years',
  'proven experience',
  'proven track record',
  'track record',
  'demonstrable experience',
  'demonstrated experience',
  'hands on experience',
  'relevant experience',
  'work experience',
  'professional experience',
  'practical experience',
  'equivalent practical experience',
  'or equivalent practical experience',
  'or equivalent experience',
  'equivalent work experience',
  'experience with',
  'experience in',
  'experience working with',
  'experience working in',
  'familiarity with',
  'knowledge of',
  'working knowledge of',
  'in depth knowledge of',
  'solid understanding of',
  'strong understanding of',
  'deep understanding of',
  'good understanding of',
  'a good understanding',
  'strong background in',
  'a background in',
  'bachelor s degree',
  'bachelors degree',
  'bachelor degree',
  'master s degree',
  'masters degree',
  'master degree',
  'university degree',
  'academic degree',
  'degree or equivalent',
  'or equivalent',
  'degree in computer science',
  'in computer science or a related field',
  'or a related field',
  'or a similar field',
  'or related discipline',
  'related field',

  // Soft-skill filler.
  'strong communication skills',
  'excellent communication skills',
  'good communication skills',
  'communication skills',
  'written and verbal communication',
  'verbal and written communication',
  'written and spoken',
  'excellent written and spoken english',
  'excellent english',
  'fluent in english',
  'fluency in english',
  'business english',
  'strong problem solving skills',
  'problem solving skills',
  'analytical skills',
  'analytical and problem solving',
  'attention to detail',
  'eye for detail',
  'team player',
  'a team player',
  'self starter',
  'can do mentality',
  'hands on mentality',
  'a proactive attitude',
  'proactive attitude',
  'ability to work independently',
  'able to work independently',
  'work independently',
  'as well as part of a team',
  'as part of a team',
  'in a team',
  'a team environment',
  'stakeholder management',
  'interpersonal skills',
  'organisational skills',
  'organizational skills',
  'time management skills',
  'willingness to learn',
  'eager to learn',
  'passion for',
  'passionate about',
  'enthusiasm for',
  'a positive attitude',

  // Environment and ways of working.
  'fast paced environment',
  'in a fast paced environment',
  'fast paced and dynamic environment',
  'dynamic environment',
  'dynamic and international environment',
  'international environment',
  'collaborative environment',
  'in a collaborative environment',
  'informal atmosphere',
  'flat hierarchy',
  'no nonsense',
  'agile environment',
  'agile methodologies',
  'agile methodology',
  'agile way of working',
  'agile scrum',
  'scrum team',
  'sprint planning',
  'daily stand ups',
  'ways of working',
  'start up environment',
  'scale up environment',

  // Benefits and offer.
  'we offer',
  'we also offer',
  'on offer',
  'our offer',
  'in return we offer',
  'in return you will get',
  'you will receive',
  'competitive salary',
  'a competitive salary',
  'competitive salary and benefits',
  'competitive salary and benefits package',
  'salary and benefits',
  'benefits package',
  'competitive compensation',
  'compensation and benefits',
  'competitive package',
  'attractive package',
  'depending on experience',
  'in line with experience',
  'commensurate with experience',
  'pension scheme',
  'pension plan',
  'pension contribution',
  'health insurance',
  'travel allowance',
  'commuting allowance',
  'holiday allowance',
  'days of holiday',
  'days of paid holiday',
  'days of annual leave',
  'vacation days',
  'holiday days',
  'paid time off',
  'annual bonus',
  'performance bonus',
  'stock options',
  'share options',
  'equity package',
  'learning budget',
  'training budget',
  'certification budget',
  'personal development budget',
  'learning and development budget',
  'learning and development',
  'personal and professional development',
  'professional development',
  'career growth',
  'career development',
  'career progression',
  'opportunities for growth',
  'opportunities for career growth',
  'room to grow',
  'grow your career',
  'growth opportunities',
  'work life balance',
  'a good work life balance',
  'flexible working hours',
  'flexible hours',
  'flexible working',
  'hybrid working',
  'hybrid working arrangement',
  'hybrid work model',
  'hybrid model',
  'remote friendly',
  'work from home',
  'working from home',
  'home office',
  'laptop of your choice',
  'team events',
  'company outings',
  'friday drinks',
  'free lunch',
  'lunch is provided',
  'a great place to work',
  'great place to work',
  'a nice office',
  'in the heart of',

  // Employment terms.
  'full time',
  'part time',
  'permanent contract',
  'permanent position',
  'fixed term contract',
  'temporary contract',
  'hours per week',
  'days a week',
  'days per week',
  'start date',
  'as soon as possible',
  'immediate start',
  'notice period',

  // Equal-opportunity and legal boilerplate.
  'equal opportunity employer',
  'an equal opportunity employer',
  'equal employment opportunity',
  'equal opportunities employer',
  'we are an equal opportunity employer',
  'all qualified applicants',
  'qualified applicants will receive consideration for employment',
  'will receive consideration for employment',
  'receive consideration for employment',
  'without regard to',
  'regardless of',
  'we celebrate diversity',
  'we value diversity',
  'diversity and inclusion',
  'diverse and inclusive',
  'an inclusive workplace',
  'inclusive culture',
  'we are committed to',
  'committed to creating',
  'we believe that',
  'we believe in',
  'our mission is to',
  'our mission',
  'our vision',
  'our values',
  'our people',
  'background check',
  'pre employment screening',
  'right to work',
  'valid work permit',
  'please note that',
  'please note',
  'acquisition based on this vacancy is not appreciated',
  'no agencies please',
  'recruitment agencies',
  'unsolicited resumes',
  'unsolicited applications',

  // Closers.
  'apply now',
  'apply today',
  'click apply',
  'apply directly',
  'apply through',
  'submit your application',
  'send us your cv',
  'send your cv',
  'upload your cv',
  'your cv and motivation',
  'cover letter',
  'motivation letter',
  'we look forward to receiving your application',
  'we look forward to hearing from you',
  'we would love to hear from you',
  'we will get back to you',
  'get in touch',
  'feel free to reach out',
  'if you have any questions',
  'if this sounds like you',
  'sounds like you',
  'does this sound like you',
  'we are excited to meet you',
  'the application process',
  'the hiring process',
  'first interview',
  'second interview',
  'the next step',
  'the next steps',
];

/**
 * Single words that appear in an advert because it is an advert, not because of the job.
 *
 * Ordinary English function words are here for the same reason a search index drops them: they are
 * present in every text and so distinguish none. The rest are the recruiting register itself
 * ("candidate", "salary", "benefits", "motivated"), plus the protected-characteristic vocabulary
 * that only ever occurs inside a boilerplate equal-opportunity paragraph.
 *
 * A word stays out of this list when it could plausibly be the subject of a job rather than the
 * packaging around one -- "platform", "data", "customers", "security" and every product, stack and
 * domain term are deliberately absent, because those are exactly the words the similarity score is
 * meant to be measuring.
 */
const BOILERPLATE_TOKENS: ReadonlySet<string> = new Set([
  // Function words.
  'about', 'above', 'across', 'after', 'again', 'against', 'all', 'also', 'am', 'among', 'an',
  'and', 'any', 'anyone', 'are', 'around', 'as', 'at', 'back', 'be', 'because', 'been', 'before',
  'being', 'below', 'between', 'both', 'but', 'by', 'can', 'cannot', 'could', 'did', 'do', 'does',
  'doing', 'done', 'down', 'during', 'each', 'either', 'else', 'etc', 'even', 'ever', 'every',
  'few', 'for', 'from', 'further', 'get', 'give', 'go', 'had', 'has', 'have', 'having', 'he',
  'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'however', 'if', 'in', 'inside',
  'into', 'is', 'it', 'its', 'itself', 'just', 'like', 'made', 'make', 'many', 'may', 'me',
  'might', 'more', 'most', 'much', 'must', 'my', 'myself', 'need', 'needs', 'no', 'nor', 'not',
  'now', 'of', 'off', 'on', 'once', 'one', 'only', 'onto', 'or', 'other', 'others', 'ought', 'our',
  'ours', 'ourselves', 'out', 'over', 'own', 'per', 'put', 'same', 'shall', 'she', 'should', 'since',
  'so', 'some', 'someone', 'something', 'still', 'such', 'take', 'than', 'that', 'the', 'their',
  'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'this', 'those', 'through',
  'throughout', 'to', 'too', 'towards', 'under', 'until', 'up', 'upon', 'us', 'use', 'used',
  'using', 'very', 'via', 'was', 'we', 'well', 'were', 'what', 'when', 'where', 'whether', 'which',
  'while', 'who', 'whom', 'whose', 'why', 'will', 'with', 'within', 'without', 'would', 'you',
  'your', 'yours', 'yourself',

  // The recruiting register.
  'ability', 'able', 'accountable', 'add', 'advantage', 'advert', 'advertisement',
  'ambitious', 'applicant', 'applicants', 'application', 'applications', 'apply', 'appreciated',
  'approach', 'aspects', 'assignment', 'attitude', 'available', 'basis', 'benefit', 'benefits',
  'bonus', 'brings', 'budget', 'candidate', 'candidates', 'career', 'colleague', 'colleagues',
  'come', 'comfortable', 'commitment', 'committed', 'communicate', 'communication', 'company',
  'compensation', 'competitive', 'contract', 'contribute', 'contribution', 'culture', 'curious',
  'cv', 'daily', 'day', 'days', 'dedicated', 'degree', 'deliver', 'delivering', 'delivery',
  'department', 'desirable', 'detail', 'details', 'development', 'diploma', 'discipline', 'diverse',
  'diversity', 'drive', 'driven', 'duties', 'eager', 'employee', 'employees', 'employer',
  'employment', 'energetic', 'engaged', 'engaging', 'ensure', 'ensuring', 'enthusiasm',
  'enthusiastic', 'environment', 'equal', 'equivalent', 'essential', 'excellent', 'expect',
  'expected', 'experience', 'experienced', 'expertise', 'fit', 'flexible', 'focus', 'focused',
  'forward', 'fte', 'full', 'fun', 'future', 'goal', 'goals', 'good', 'great', 'grow', 'growing',
  'growth', 'help', 'hiring', 'holiday', 'hours', 'ideal', 'ideally', 'important', 'impact',
  'improve', 'inclusion', 'inclusive', 'independently', 'individual', 'informal', 'initiative',
  'innovative', 'inspiring', 'interview', 'job', 'join', 'journey', 'key', 'knowledge', 'learn',
  'learning', 'letter', 'level', 'looking', 'love', 'match', 'mentality', 'mindset', 'minimum',
  'mission', 'motivated', 'motivation', 'new', 'offer', 'office', 'opportunities', 'opportunity',
  'organisation', 'organization', 'ownership', 'part', 'passion', 'passionate', 'people',
  'perfect', 'performance', 'permanent', 'person', 'personal', 'plus', 'position', 'positive',
  'preferably', 'preferred', 'proactive', 'process', 'professional', 'profile', 'proven',
  'qualification', 'qualifications', 'qualified', 'quality', 'recruiter', 'recruitment',
  'references', 'relevant', 'reporting', 'requirement', 'requirements', 'required', 'responsibility',
  'responsible', 'resume', 'reward', 'rewarding', 'role', 'roles', 'salary', 'seeking', 'sharp',
  'skill', 'skills', 'smart', 'solid', 'sounds', 'spoken', 'staff', 'stakeholder', 'stakeholders',
  'standard', 'standards', 'start', 'starter', 'strong', 'succeed', 'success', 'successful',
  'suitable', 'talent', 'talented', 'task', 'tasks', 'team', 'teams', 'thrive', 'time', 'together',
  'track', 'training', 'understanding', 'vacancy', 'valued', 'values', 'want', 'welcome', 'willing',
  'willingness', 'work', 'working', 'write', 'written', 'year', 'years',

  // Protected characteristics: only ever the equal-opportunity paragraph.
  'age', 'ancestry', 'characteristic', 'characteristics', 'citizenship', 'color', 'colour',
  'creed', 'disability', 'ethnic', 'ethnicity', 'gender', 'identity', 'marital', 'national',
  'nationality', 'origin', 'orientation', 'pregnancy', 'protected', 'race', 'religion', 'sex',
  'sexual', 'status', 'veteran',
]);

function tokenize(text: string): string[] {
  return normalizeVacancyText(text)
    .split(/[^\p{Letter}\p{Number}]+/u)
    .filter((token) => token.length > 0);
}

/** Phrases indexed by first token, longest first, so a greedy scan takes the longest match. */
const PHRASES_BY_FIRST_TOKEN: ReadonlyMap<string, readonly string[][]> = (() => {
  const index = new Map<string, string[][]>();
  for (const phrase of BOILERPLATE_PHRASES) {
    const tokens = tokenize(phrase);
    const first = tokens[0];
    if (first === undefined) continue;
    const bucket = index.get(first);
    if (bucket) bucket.push(tokens);
    else index.set(first, [tokens]);
  }
  for (const bucket of index.values()) bucket.sort((left, right) => right.length - left.length);
  return index;
})();

const LONGEST_PHRASE_TOKENS = Math.max(
  ...[...PHRASES_BY_FIRST_TOKEN.values()].flatMap((bucket) => bucket.map((tokens) => tokens.length)),
);

function matchedPhraseLength(tokens: readonly string[], start: number): number {
  const bucket = PHRASES_BY_FIRST_TOKEN.get(tokens[start]!);
  if (bucket === undefined) return 0;
  for (const phrase of bucket) {
    if (start + phrase.length > tokens.length) continue;
    let matches = true;
    for (let offset = 0; offset < phrase.length; offset += 1) {
      if (tokens[start + offset] !== phrase[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return phrase.length;
  }
  return 0;
}

/** Every token of the description, template language included. The input to the raw-length floor,
 * which is a check on how much text a source gave us at all, not on how much of it says something. */
export function descriptionTokens(description: string): Set<string> {
  return new Set(tokenize(description).filter((token) => token.length > 1));
}

/**
 * The description with its template language subtracted, **in the order it was written**.
 *
 * Bare numbers go too. "3 years", "25 days", "40 hours" are quantities attached to boilerplate, and
 * two postings agreeing that a number exists is not evidence they are the same posting.
 *
 * Order is the whole point of returning a list rather than a set, and it is what the shingle
 * similarity in `cross-company-duplicates.ts` consumes. Two postings that share a vocabulary but
 * were written by two different people put that vocabulary in two different orders; two copies of
 * one posting do not. A set throws away exactly the signal that distinguishes them.
 *
 * Repeats are kept for the same reason: a word used twice in one posting and once in the other is a
 * real difference in the text, and collapsing it would hide a rewrite.
 */
export function substantiveDescriptionTokenSequence(description: string): string[] {
  const tokens = tokenize(description);
  const substantive: string[] = [];
  let index = 0;
  while (index < tokens.length) {
    const phraseLength = LONGEST_PHRASE_TOKENS > 0 ? matchedPhraseLength(tokens, index) : 0;
    if (phraseLength > 0) {
      index += phraseLength;
      continue;
    }
    const token = tokens[index]!;
    if (token.length > 1 && !BOILERPLATE_TOKENS.has(token) && !/^\d+$/.test(token)) {
      substantive.push(token);
    }
    index += 1;
  }
  return substantive;
}

/**
 * The distinct substantive vocabulary of a description.
 *
 * Used only as a *volume* check now -- "does this posting say anything job-specific at all", i.e.
 * `CROSS_COMPANY_MINIMUM_SUBSTANTIVE_DESCRIPTION_TOKENS` -- and no longer as a similarity measure.
 * See the v3 note in `cross-company-duplicates.ts` for why comparing two of these sets turned out to
 * be unable to separate a repost from a coincidence.
 */
export function substantiveDescriptionTokens(description: string): Set<string> {
  return new Set(substantiveDescriptionTokenSequence(description));
}
