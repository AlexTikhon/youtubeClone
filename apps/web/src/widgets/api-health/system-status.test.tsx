import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SystemStatus } from './system-status';

describe('SystemStatus', () => {
  it('renders a clear degraded state', () => {
    render(<SystemStatus state="unavailable" />);
    expect(screen.getByText('API unavailable')).toBeInTheDocument();
  });
});
