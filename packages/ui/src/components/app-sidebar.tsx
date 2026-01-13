"use client"

import * as React from "react"
import {
  InboxIcon,
  ListTodoIcon,
  MessageSquareIcon,
  UsersIcon,
  SettingsIcon,
  LogOutIcon,
} from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "./ui/sidebar"
import { Button } from "./ui/button"

const navigation = [
  { title: "Inbox", href: "/inbox", icon: InboxIcon },
  { title: "Actions", href: "/actions", icon: ListTodoIcon },
  { title: "Assistant", href: "/assistant", icon: MessageSquareIcon },
  { title: "Contacts", href: "/contacts", icon: UsersIcon },
  { title: "Settings", href: "/settings", icon: SettingsIcon },
]

interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  user?: {
    name?: string
    email?: string
  } | null
  onSignOut?: () => void
}

export function AppSidebar({ user, onSignOut, ...props }: AppSidebarProps) {
  return (
    <Sidebar {...props}>
      <SidebarHeader className="border-b border-sidebar-border p-4">
        <div className="flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
            <MessageSquareIcon className="size-4" />
          </div>
          <span className="font-semibold">PRM</span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navigation.map(({ title, href, icon: Icon }) => (
                <SidebarMenuItem key={href}>
                  <SidebarMenuButton render={<a href={href} />}>
                    <Icon className="size-4" />
                    <span>{title}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border p-4">
        <div className="flex flex-col gap-2">
          {user && (
            <div className="flex flex-col gap-1 text-sm">
              {user.name && (
                <span className="font-medium text-sidebar-foreground">
                  {user.name}
                </span>
              )}
              {user.email && (
                <span className="text-xs text-sidebar-foreground/70">
                  {user.email}
                </span>
              )}
            </div>
          )}
          {onSignOut && (
            <>
              <SidebarSeparator className="my-1" />
              <Button
                variant="ghost"
                size="sm"
                onClick={onSignOut}
                className="justify-start gap-2 px-2"
              >
                <LogOutIcon className="size-4" />
                <span>Sign Out</span>
              </Button>
            </>
          )}
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
