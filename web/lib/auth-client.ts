import { createAuthClient } from 'better-auth/react'
import { organizationClient } from 'better-auth/client/plugins'

const baseURL =
  process.env.NEXT_PUBLIC_AUTH_BASE_URL ?? 'http://localhost:8787/api/auth'

const FRONTEND_URL =
  process.env.NEXT_PUBLIC_FRONTEND_URL || 'http://localhost:3000'

export const authClient = createAuthClient({
  baseURL,
  fetchOptions: {
    credentials: 'include',
  },
  plugins: [organizationClient()],
})

// Email authentication\
export const signUp = async (data: {
  email: string
  password: string
  name: string
}) => {
  const result = await authClient.signUp.email({
    email: data.email,
    password: data.password,
    name: data.name,
    callbackURL: `${FRONTEND_URL}/dashboard`,
  })
  return result
}

export const signIn = async (data: { email: string; password: string }) => {
  const result = await authClient.signIn.email({
    email: data.email,
    password: data.password,
    callbackURL: `${FRONTEND_URL}/dashboard`,
  })
  return result
}

// Social authentication
export const googleSignIn = async () => {
  const data = await authClient.signIn.social({
    provider: 'google',
    callbackURL: `${FRONTEND_URL}/dashboard`,
  })
  return data
}

export const githubSignIn = async () => {
  const data = await authClient.signIn.social({
    provider: 'github',
    callbackURL: `${FRONTEND_URL}/dashboard`,
  })
  return data
}

// Session management
export const signOut = async () => {
  const result = await authClient.signOut()
  return result
}

export const getSession = async () => {
  const session = await authClient.getSession()
  return session
}

// Export the useSession hook for components
export const useSession = authClient.useSession

// Organization management
export const createOrganization = async (data: {
  name: string
  slug: string
  logo?: string
  metadata?: Record<string, unknown>
}) => {
  const result = await authClient.organization.create({
    name: data.name,
    slug: data.slug,
    logo: data.logo,
    metadata: data.metadata,
  })
  return result
}

export const updateOrganization = async (data: {
  organizationId: string
  name?: string
  slug?: string
  logo?: string
  metadata?: Record<string, unknown>
}) => {
  const result = await authClient.organization.update({
    organizationId: data.organizationId,
    data: {
      name: data.name,
      slug: data.slug,
      logo: data.logo,
      metadata: data.metadata,
    },
  })
  return result
}

export const deleteOrganization = async (organizationId: string) => {
  const result = await authClient.organization.delete({
    organizationId,
  })
  return result
}

export const setActiveOrganization = async (organizationId: string | null) => {
  const result = await authClient.organization.setActive({
    organizationId,
  })
  return result
}

export const listOrganizations = async () => {
  const result = await authClient.organization.list()
  return result
}

// Export the useActiveOrganization and useListOrganizations hooks
export const useActiveOrganization = authClient.useActiveOrganization
export const useListOrganizations = authClient.useListOrganizations
