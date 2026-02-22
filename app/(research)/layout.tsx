import Providers from './providers';
import AppHeader from './components/AppHeader';
import ThemeInitializer from './components/ThemeInitializer';

export default function ResearchLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <Providers>
      <ThemeInitializer />
      <AppHeader />
      <main>{children}</main>
    </Providers>
  );
}
