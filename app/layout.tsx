import './styles/globals.css';

export const metadata = {
  title: 'Multi-API Research',
  description: 'Run deep research across OpenAI and Gemini.'
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
