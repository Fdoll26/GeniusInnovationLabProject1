// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('sendReportEmail', () => {
  it('noops when stub=true even without env', async () => {
    delete process.env.SENDGRID_API_KEY;
    delete process.env.EMAIL_FROM;
    const { sendReportEmail } = await import('../../app/lib/email-sender');
    await expect(
      sendReportEmail(
        {
          to: 'user@example.com',
          subject: 'Subject',
          summary: 'Summary',
          pdfBuffer: Buffer.from('pdf')
        },
        { stub: true }
      )
    ).resolves.toBeUndefined();
  });

  it('throws when SENDGRID_API_KEY is missing', async () => {
    delete process.env.SENDGRID_API_KEY;
    process.env.EMAIL_FROM = 'from@example.com';
    const { sendReportEmail } = await import('../../app/lib/email-sender');
    await expect(
      sendReportEmail({
        to: 'user@example.com',
        subject: 'Subject',
        summary: 'Summary',
        pdfBuffer: Buffer.from('pdf')
      })
    ).rejects.toThrow('SENDGRID_API_KEY');
  });

  it('posts to SendGrid when configured', async () => {
    process.env.SENDGRID_API_KEY = 'key';
    process.env.EMAIL_FROM = 'from@example.com';

    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () => ''
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { sendReportEmail } = await import('../../app/lib/email-sender');
    await sendReportEmail({
      to: 'user@example.com',
      subject: 'Subject',
      summary: 'Summary',
      pdfBuffer: Buffer.from('pdf')
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.sendgrid.com/v3/mail/send',
      expect.objectContaining({ method: 'POST' })
    );
  });
});

