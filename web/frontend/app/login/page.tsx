import { LoginScreen } from '@/components/auth/LoginScreen'

export default function LoginPage() {
  const rawMode = process.env.A_TERM_AUTH_MODE
  const authMode =
    rawMode === 'password' || rawMode === 'proxy' ? rawMode : 'none'

  return <LoginScreen authMode={authMode} />
}
