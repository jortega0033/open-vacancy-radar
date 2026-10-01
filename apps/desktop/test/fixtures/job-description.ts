/**
 * A synthetic job description long enough, and with enough requirement wording, to pass the
 * completeness check (`assessJdCompleteness`), for tests that need a case a candidate could approve.
 */
export const FULL_JD = [
  'Northwind Freight is hiring a Logistics Platform Engineer to join a small product team.',
  'You will build and operate the services that plan, track and report on freight movements across several regions, working closely with operations staff who use the tools every day.',
  'Requirements:',
  '- You must have at least 4 years of experience building web applications with TypeScript.',
  '- Experience with relational databases and writing maintainable SQL is required.',
  '- Fluent English is essential because the team works across time zones.',
  'Nice to have:',
  '- Experience with message queues and event-driven services.',
  '- Familiarity with container orchestration and continuous delivery.',
  'The team reviews every change together, writes its own tests and owns what it ships.',
].join('\n');
