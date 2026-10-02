import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CvSourceReview } from '../../../src/components/cv-library/CvSourceReview.js';
import { EMPTY_CV_SOURCE, type CvSourceDocument } from '../../../electron/workspace/cv-source-schema.js';

/**
 * The review step #274 puts between reading a CV into records and using them. Everything asserted
 * here is a fact the ticket names as previously lost: a contact correction the candidate makes, the
 * pin that keeps a project through tailoring, the configurable count, the distinction between a job
 * and a contract, and an honest "this CV was not read to the end" state.
 *
 * All fixture content is synthetic.
 */

const SOURCE: CvSourceDocument = {
  ...EMPTY_CV_SOURCE,
  contact: {
    name: 'Jamie Rivera',
    title: 'Senior Frontend Engineer',
    location: 'Amsterdam, Netherlands',
    email: 'typo@example.invalid',
    phone: '',
    links: ['https://example.invalid/jamie'],
  },
  experience: [
    {
      id: 'experience-1',
      company: 'Beacon Consultancy',
      title: 'Frontend Consultant',
      dates: 'Jan 2019 - Feb 2021',
      engagement: 'client_engagement',
      client: 'Northwind Retail',
      bullets: [],
    },
  ],
  education: [{ institution: 'TU Delft', credential: 'BSc Computer Science', dates: '2014 - 2018' }],
  projects: [
    {
      id: 'project-1',
      name: 'Aurora Design System',
      role: 'Lead',
      dates: '2022',
      organization: 'Redwood Software',
      description: '',
      technologies: [],
      links: [],
      pinned: false,
    },
    {
      id: 'project-2',
      name: 'Checkout Rebuild',
      role: 'Consultant',
      dates: '2020',
      organization: 'Northwind Retail',
      description: '',
      technologies: [],
      links: [],
      pinned: false,
    },
  ],
};

describe('CvSourceReview (#274)', () => {
  it('shows the employers, dates, education and projects read out of the CV', () => {
    render(<CvSourceReview source={SOURCE} onChange={vi.fn()} />);

    expect(screen.getByText(/Frontend Consultant, Beacon Consultancy/)).toBeInTheDocument();
    expect(screen.getByText('Jan 2019 - Feb 2021')).toBeInTheDocument();
    expect(screen.getByText(/BSc Computer Science, TU Delft/)).toBeInTheDocument();
    expect(screen.getByText('Aurora Design System')).toBeInTheDocument();
    expect(screen.getByText('Checkout Rebuild')).toBeInTheDocument();
  });

  it('lets the candidate correct a contact detail the extraction got wrong', () => {
    const onChange = vi.fn();
    render(<CvSourceReview source={SOURCE} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'jamie@example.invalid' } });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ contact: expect.objectContaining({ email: 'jamie@example.invalid' }) }),
    );
  });

  it('keeps a client engagement distinct, with its own end client field', () => {
    const onChange = vi.fn();
    render(<CvSourceReview source={SOURCE} onChange={onChange} />);

    expect(screen.getByDisplayValue('Northwind Retail')).toBeInTheDocument();

    // Switching to direct employment clears the end client rather than leaving a stale one behind.
    fireEvent.change(screen.getByLabelText('How Frontend Consultant was held'), {
      target: { value: 'employment' },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        experience: [expect.objectContaining({ engagement: 'employment', client: '' })],
      }),
    );
  });

  it('pins a project so tailoring always keeps it', () => {
    const onChange = vi.fn();
    render(<CvSourceReview source={SOURCE} onChange={onChange} />);

    fireEvent.click(screen.getByLabelText('Always include Checkout Rebuild'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        projects: expect.arrayContaining([expect.objectContaining({ id: 'project-2', pinned: true })]),
      }),
    );
  });

  it('makes the project count a setting rather than a fixed rule', () => {
    const onChange = vi.fn();
    render(<CvSourceReview source={SOURCE} onChange={onChange} />);

    const limit = screen.getByLabelText('Maximum projects to include') as HTMLInputElement;
    expect(limit.value).toBe('0');

    fireEvent.change(limit, { target: { value: '1' } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ maxProjects: 1 }));
  });

  it('accepts a value larger than the project count', () => {
    const onChange = vi.fn();
    render(<CvSourceReview source={SOURCE} onChange={onChange} />);

    const limit = screen.getByLabelText('Maximum projects to include');
    fireEvent.change(limit, { target: { value: '5' } });

    // Should accept the value and update the source
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ maxProjects: 5 }));
    // Should not show an error
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows helper text for every value including 0', () => {
    render(<CvSourceReview source={SOURCE} onChange={vi.fn()} />);

    const hint = screen.getByText(/You have 2 projects/);
    expect(hint).toBeInTheDocument();
    expect(hint).toHaveTextContent('Pinned projects are always kept');
    expect(hint).toHaveTextContent('0 includes every project');
  });

  it('shows an inline error for negative values', () => {
    const onChange = vi.fn();
    render(<CvSourceReview source={SOURCE} onChange={onChange} />);

    const limit = screen.getByLabelText('Maximum projects to include');
    fireEvent.change(limit, { target: { value: '-1' } });

    // Should show an error
    const error = screen.getByText('Cannot be negative.');
    expect(error).toBeInTheDocument();
    expect(error).toHaveAttribute('role', 'alert');

    // Should NOT update the source
    expect(onChange).not.toHaveBeenCalled();
  });

  it('clears the error when a valid value is entered after an error', () => {
    const onChange = vi.fn();
    render(<CvSourceReview source={SOURCE} onChange={onChange} />);

    const limit = screen.getByLabelText('Maximum projects to include');

    // First enter an invalid value
    fireEvent.change(limit, { target: { value: '-5' } });
    expect(screen.getByText('Cannot be negative.')).toBeInTheDocument();

    // Then enter a valid value
    fireEvent.change(limit, { target: { value: '3' } });
    expect(screen.queryByText('Cannot be negative.')).not.toBeInTheDocument();
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ maxProjects: 3 }));
  });

  it('says which project the count leaves out, instead of dropping it quietly', () => {
    render(<CvSourceReview source={{ ...SOURCE, maxProjects: 1 }} onChange={vi.fn()} />);
    expect(screen.getByText(/Left out by the limit above/)).toBeInTheDocument();
  });

  it('states plainly when the CV was not read to the end, and that exports are blocked', () => {
    render(
      <CvSourceReview
        source={{ ...SOURCE, complete: false, incompleteReason: 'only the first 200,000 characters could be read' }}
        onChange={vi.fn()}
      />,
    );

    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent('only the first 200,000 characters could be read');
    expect(banner).toHaveTextContent(/Exports are blocked/);
  });

  it('shows no incompleteness warning for a CV that was read in full', () => {
    render(<CvSourceReview source={SOURCE} onChange={vi.fn()} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
