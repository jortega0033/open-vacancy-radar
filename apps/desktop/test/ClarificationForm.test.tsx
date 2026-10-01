import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_CV_SOURCE } from '../electron/workspace/cv-source-schema.js';
import type { ClarificationAnswer } from '../src/components/cv/clarification-answer.js';
import { ClarificationForm } from '../src/components/cv/ClarificationForm.js';
import type { CvSourceDocument } from '../src/window.js';

const SOURCE: CvSourceDocument = {
  ...EMPTY_CV_SOURCE,
  experience: [
    { id: 'experience-1', company: 'Redwood Software', title: 'Frontend Engineer', dates: '2021 - Present', engagement: 'employment', client: '', bullets: [] },
  ],
  projects: [
    { id: 'project-1', name: 'Design System', role: 'Lead', dates: '2023', organization: '', description: '', technologies: [], links: [], pinned: false },
  ],
};

function setup() {
  const onAnswer = vi.fn<(answer: ClarificationAnswer) => void>();
  const onCancel = vi.fn();
  render(<ClarificationForm sourceCv={SOURCE} onAnswer={onAnswer} onCancel={onCancel} />);
  return { onAnswer, onCancel };
}

function chooseRoleAndActivity(activity = 'Designed the schema') {
  fireEvent.change(screen.getByLabelText(/role or project/i), { target: { value: 'experience:experience-1' } });
  fireEvent.change(screen.getByLabelText(/what did you personally do/i), { target: { value: activity } });
}

describe('ClarificationForm (#419, step 6)', () => {
  it('asks three separate questions, one at a time, in a fixed order', () => {
    setup();
    expect(screen.getByText(/question 1 of 3/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/what did you personally do, and where/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/how did you do it/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/what was the result/i)).not.toBeInTheDocument();

    chooseRoleAndActivity();
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    expect(screen.getByText(/question 2 of 3/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/how did you do it, including the actual tools and scope/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/what did you personally do/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/how did you do it/i), { target: { value: 'Apollo Server' } });
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    expect(screen.getByText(/question 3 of 3/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/what was the result, or what was it for/i)).toBeInTheDocument();
  });

  it('does not move on from a step until it has an answer', () => {
    setup();
    expect(screen.getByRole('button', { name: /^next$/i })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/what did you personally do/i), { target: { value: 'Something' } });
    // The role or project is part of the first answer.
    expect(screen.getByRole('button', { name: /^next$/i })).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/role or project/i), { target: { value: 'project:project-1' } });
    expect(screen.getByRole('button', { name: /^next$/i })).toBeEnabled();
  });

  it('lets the candidate go back without losing what they typed', () => {
    setup();
    chooseRoleAndActivity('Designed the schema');
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }));
    expect(screen.getByLabelText(/what did you personally do/i)).toHaveValue('Designed the schema');
  });

  it('saves an answer built from all three steps, with the chosen role and an optional time phase', () => {
    const { onAnswer } = setup();
    chooseRoleAndActivity('Designed the schema');
    fireEvent.change(screen.getByLabelText(/when did this happen/i), { target: { value: 'first year' } });
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    fireEvent.change(screen.getByLabelText(/how did you do it/i), { target: { value: 'Apollo Server, federated' } });
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    fireEvent.change(screen.getByLabelText(/what was the result/i), { target: { value: 'less overfetching' } });
    fireEvent.click(screen.getByRole('button', { name: /save answer/i }));

    expect(onAnswer).toHaveBeenCalledWith({
      kind: 'answered',
      parentId: 'experience-1',
      parentType: 'experience',
      activity: 'Designed the schema',
      mechanism: 'Apollo Server, federated',
      result: 'less overfetching',
      timePhase: 'first year',
    });
  });

  it('lets steps two and three stay unstated instead of guessing', () => {
    const { onAnswer } = setup();
    chooseRoleAndActivity();
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
    fireEvent.click(screen.getByRole('button', { name: /don.t know this part/i }));
    expect(screen.getByText(/question 3 of 3/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /save answer/i }));
    expect(onAnswer).toHaveBeenCalledWith(expect.objectContaining({ kind: 'answered', mechanism: '', result: '' }));
  });

  it('offers the three explicit non-answers on every step', () => {
    const { onAnswer, onCancel } = setup();
    for (let step = 1; step <= 3; step += 1) {
      expect(screen.getByRole('button', { name: /i don.t know$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /not my work/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /skip for now/i })).toBeInTheDocument();
      if (step === 1) {
        chooseRoleAndActivity();
        fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
      } else if (step === 2) {
        fireEvent.click(screen.getByRole('button', { name: /don.t know this part/i }));
      }
    }
    fireEvent.click(screen.getByRole('button', { name: /i don.t know$/i }));
    expect(onAnswer).toHaveBeenLastCalledWith({ kind: 'unknown' });
    fireEvent.click(screen.getByRole('button', { name: /not my work/i }));
    expect(onAnswer).toHaveBeenLastCalledWith({ kind: 'not_my_work' });
    fireEvent.click(screen.getByRole('button', { name: /skip for now/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not suggest any answer: every text field starts empty', () => {
    setup();
    expect(screen.getByLabelText(/what did you personally do/i)).toHaveValue('');
    expect(screen.getByLabelText(/when did this happen/i)).toHaveValue('');
  });

  describe('numbers need an explicit basis', () => {
    function reachStepThree() {
      const handlers = setup();
      chooseRoleAndActivity();
      fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
      fireEvent.change(screen.getByLabelText(/how did you do it/i), { target: { value: 'Apollo Server' } });
      fireEvent.click(screen.getByRole('button', { name: /^next$/i }));
      return handlers;
    }

    it('blocks saving a number with no stated source', () => {
      const { onAnswer } = reachStepThree();
      fireEvent.change(screen.getByLabelText(/number, if there is one/i), { target: { value: '30%' } });
      expect(screen.getByRole('button', { name: /save answer/i })).toBeDisabled();
      expect(screen.getByText(/needs a stated source/i)).toBeInTheDocument();
      expect(onAnswer).not.toHaveBeenCalled();
    });

    it('refuses a basis that infers the result from test counts, commits or a deployed address', () => {
      reachStepThree();
      fireEvent.change(screen.getByLabelText(/number, if there is one/i), { target: { value: '30%' } });
      fireEvent.change(screen.getByLabelText(/where does that number come from/i), { target: { value: 'counted from the number of tests' } });
      expect(screen.getByRole('button', { name: /save answer/i })).toBeDisabled();
      expect(screen.getByText(/cannot be worked out from code, test counts or a deployed address/i)).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText(/where does that number come from/i), { target: { value: 'the live url shows it' } });
      expect(screen.getByRole('button', { name: /save answer/i })).toBeDisabled();
    });

    it('saves the number with its unit and basis once the candidate says where it came from', () => {
      const { onAnswer } = reachStepThree();
      fireEvent.change(screen.getByLabelText(/number, if there is one/i), { target: { value: '30%' } });
      fireEvent.change(screen.getByLabelText(/^unit$/i), { target: { value: 'percent' } });
      fireEvent.change(screen.getByLabelText(/where does that number come from/i), { target: { value: 'a report my manager sent' } });
      fireEvent.click(screen.getByRole('button', { name: /save answer/i }));
      expect(onAnswer).toHaveBeenCalledWith(
        expect.objectContaining({ metricValue: '30%', metricUnit: 'percent', metricBasis: 'a report my manager sent' }),
      );
    });

    it('does not ask for a basis when there is no number', () => {
      const { onAnswer } = reachStepThree();
      expect(screen.getByRole('button', { name: /save answer/i })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: /save answer/i }));
      expect(onAnswer.mock.calls[0]?.[0]).not.toHaveProperty('metricValue');
    });
  });
});
