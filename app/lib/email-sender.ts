const sendgridApiKey = process.env.SENDGRID_API_KEY;
const emailFrom = process.env.EMAIL_FROM;

export async function sendReportEmail(params: {
  to: string;
  subject: string;
  summary: string;
  pdfBuffer: Buffer;
}, opts?: { stub?: boolean }) {
  if (opts?.stub) {
    return;
  }
  if (!sendgridApiKey) {
    throw new Error('SENDGRID_API_KEY is not set');
  }
  if (!emailFrom) {
    throw new Error('EMAIL_FROM is not set');
  }

  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${sendgridApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      personalizations: [
        {
          to: [{ email: params.to }]
        }
      ],
      from: { email: emailFrom },
      subject: params.subject,
      content: [
        {
          type: 'text/plain',
          value: params.summary
        }
      ],
      attachments: [
        {
          content: params.pdfBuffer.toString('base64'),
          filename: 'research-report.pdf',
          type: 'application/pdf',
          disposition: 'attachment'
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`SendGrid error: ${errorText}`);
  }
}
