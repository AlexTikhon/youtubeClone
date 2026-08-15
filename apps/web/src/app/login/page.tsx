import { LoginForm } from '@/features/auth/login-form';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  return (
    <main className="mx-auto max-w-md px-6 py-16">
      <LoginForm next={next} />
    </main>
  );
}
