import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SearchForm } from './search-form';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams(),
}));

describe('SearchForm', () => {
  it('normalizes the query and navigates on submit', () => {
    render(<SearchForm />);
    fireEvent.change(screen.getByLabelText('Search videos'), {
      target: { value: '  react   architecture  ' },
    });
    fireEvent.submit(screen.getByRole('form', { name: 'Video search' }));
    expect(push).toHaveBeenCalledWith('/search?q=react%20architecture');
  });
});
