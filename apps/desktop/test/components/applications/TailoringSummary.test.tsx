import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TailoringSummary } from '../../../src/components/applications/TailoringSummary.js';

describe('TailoringSummary', () => {
  it('renders base text without removals', () => {
    render(<TailoringSummary detail="CV tailored for this vacancy." />);
    expect(screen.getByText('CV tailored for this vacancy.')).toBeInTheDocument();
  });

  it('renders summary and disclosure for skill removals', () => {
    render(
      <TailoringSummary detail='CV tailored for this vacancy. Removed unsupported output: skill "React" is not in your reviewed CV profile.' />,
    );

    expect(screen.getByText(/1 skill from this vacancy is not in your CV, so they were left out/)).toBeInTheDocument();
    expect(screen.getByText(/Show which skill/)).toBeInTheDocument();
    expect(screen.getByText('React')).toBeInTheDocument();
  });

  it('shows disclosure details on click', () => {
    render(<TailoringSummary detail='CV tailored for this vacancy. Removed unsupported output: skill "Rust" is not in your reviewed CV profile.' />);

    const summary = screen.getByText(/Show which/);
    fireEvent.click(summary);

    expect(screen.getByText('Add these to your CV if they are true.')).toBeInTheDocument();
  });

  it('formats multiple items in disclosure', () => {
    render(
      <TailoringSummary detail='CV tailored for this vacancy. Removed unsupported output: skill "Python" is not in your reviewed CV profile; skill "Go" is not in your reviewed CV profile; skill "Rust" is not in your reviewed CV profile.' />,
    );

    const summary = screen.getByText(/Show which/);
    fireEvent.click(summary);

    expect(screen.getByText('3 skills')).toBeInTheDocument();
    expect(screen.getByText('Python')).toBeInTheDocument();
    expect(screen.getByText('Go')).toBeInTheDocument();
    expect(screen.getByText('Rust')).toBeInTheDocument();
  });

  it('groups mixed removal types correctly', () => {
    render(
      <TailoringSummary detail='CV tailored for this vacancy. Removed unsupported output: skill "Rust" is not in your reviewed CV profile; rewritten bullet for "DevOps Engineer at Startup" was not an exact reviewed fact; summary rewrite was not an exact reviewed fact.' />,
    );

    const summary = screen.getByText(/Show which/);
    fireEvent.click(summary);

    expect(screen.getByText('1 skill')).toBeInTheDocument();
    expect(screen.getByText('1 bullet')).toBeInTheDocument();
    expect(screen.getByText('summary rewrite was not an exact reviewed fact')).toBeInTheDocument();
    expect(screen.getByText('Rust')).toBeInTheDocument();
    expect(screen.getByText('DevOps Engineer at Startup')).toBeInTheDocument();
  });
});
