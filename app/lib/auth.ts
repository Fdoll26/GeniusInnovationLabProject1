import type { NextAuthOptions } from 'next-auth';
import NextAuth from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';
import { query } from './db';

const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const hasGoogleProvider = Boolean(googleClientId && googleClientSecret);

export const authOptions: NextAuthOptions = {
  providers: hasGoogleProvider
    ? [
        GoogleProvider({
          clientId: googleClientId as string,
          clientSecret: googleClientSecret as string
        })
      ]
    : [],
  session: {
    strategy: 'jwt'
  },
  callbacks: {
    async signIn({ user }) {
      if (!user.email) {
        return false;
      }

      await query(
        `INSERT INTO users (email, name, image_url)
         VALUES ($1, $2, $3)
         ON CONFLICT (email)
         DO UPDATE SET name = EXCLUDED.name, image_url = EXCLUDED.image_url, updated_at = now()`
      , [user.email, user.name ?? null, user.image ?? null]);
      return true;
    },
    async session({ session }) {
      return session;
    }
  }
};

export const authHandler = NextAuth(authOptions);
