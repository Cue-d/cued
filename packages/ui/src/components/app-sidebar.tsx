"use client";

import * as React from "react";
import {
  InboxIcon,
  ListTodoIcon,
  MessageSquareIcon,
  UsersIcon,
  LinkIcon,
  SettingsIcon,
  LogOutIcon,
  SunIcon,
  MoonIcon,
  ChevronsUpDownIcon,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { useTheme } from "next-themes";
import { CuedLogo } from "./cued-logo";
import { cn } from "../lib/utils";
import { Avatar, AvatarFallback } from "./ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "./ui/sidebar";

const navigation = [
  { title: "Inbox", href: "/inbox", icon: InboxIcon },
  { title: "Actions", href: "/actions", icon: ListTodoIcon },
  { title: "Assistant", href: "/assistant", icon: MessageSquareIcon },
  { title: "Contacts", href: "/contacts", icon: UsersIcon },
];

interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  user?: {
    name?: string;
    email?: string;
  } | null;
  onSignOut?: () => void;
  /** Number of pending actions for badge */
  actionCount?: number;
}

export function AppSidebar({
  user,
  onSignOut,
  actionCount = 0,
  ...props
}: AppSidebarProps) {
  const { setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  const [prevCount, setPrevCount] = React.useState(actionCount);
  const [isAnimating, setIsAnimating] = React.useState(false);
  const [logoHovered, setLogoHovered] = React.useState(false);
  const logoGroupRef = React.useRef<HTMLDivElement>(null);

  // Animate badge when count changes
  React.useEffect(() => {
    if (actionCount !== prevCount && actionCount > 0) {
      setIsAnimating(true);
      const timer = setTimeout(() => setIsAnimating(false), 300);
      setPrevCount(actionCount);
      return () => clearTimeout(timer);
    }
    setPrevCount(actionCount);
  }, [actionCount, prevCount]);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  const isDarkMode = mounted && resolvedTheme === "dark";

  const getInitials = (name?: string, email?: string) => {
    if (name) {
      return name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2);
    }
    if (email) {
      return email[0].toUpperCase();
    }
    return "U";
  };

  return (
    <Sidebar {...props} variant="inset">
      <SidebarHeader className="border-b border-sidebar-border p-4">
        <div
          ref={logoGroupRef}
          className="flex items-center gap-2 cursor-pointer"
          onMouseEnter={() => setLogoHovered(true)}
          onMouseLeave={() => setLogoHovered(false)}
        >
          <CuedLogo size={24} interactive trackingRef={logoGroupRef} />
          <span className="font-semibold inline-flex">
            <span>Cue</span>
            <span className="relative inline-flex">
              <AnimatePresence>
                {logoHovered && (
                  <motion.span
                    className="inline-block"
                    initial={{ opacity: 0, rotate: -4, width: 0, filter: "blur(3px)" }}
                    animate={{ opacity: 1, rotate: 8, width: "auto", filter: "blur(0px)" }}
                    exit={{ opacity: 0, rotate: -4, width: 0, filter: "blur(3px)" }}
                    transition={{
                      type: "spring",
                      stiffness: 325,
                      damping: 25,
                    }}
                  >
                    &apos;
                  </motion.span>
                )}
              </AnimatePresence>
              <span>d</span>
            </span>
          </span>
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
                  {title === "Actions" && actionCount > 0 && (
                    <SidebarMenuBadge
                      className={cn(
                        "transition-transform duration-200",
                        isAnimating && "scale-125"
                      )}
                    >
                      {actionCount > 99 ? "99+" : actionCount}
                    </SidebarMenuBadge>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger
                className="w-full rounded-md ring-sidebar-ring focus-visible:ring-2 outline-hidden"
                render={
                  <SidebarMenuButton
                    size="lg"
                    className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                  />
                }
              >
                <Avatar className="size-8 rounded-lg">
                  <AvatarFallback className="rounded-lg bg-sidebar-primary text-sidebar-primary-foreground text-xs">
                    {getInitials(user?.name, user?.email)}
                  </AvatarFallback>
                </Avatar>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-medium">
                    {user?.name || "User"}
                  </span>
                  <span className="truncate text-xs text-sidebar-foreground/70">
                    {user?.email}
                  </span>
                </div>
                <ChevronsUpDownIcon className="ml-auto size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                className="w-[--anchor-width] min-w-56 rounded-lg"
                side="top"
                align="start"
                sideOffset={4}
              >
                <DropdownMenuItem render={<a href="/settings" />}>
                  <SettingsIcon />
                  Settings
                </DropdownMenuItem>
                <DropdownMenuItem render={<a href="/settings/integrations" />}>
                  <LinkIcon />
                  Integrations
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => setTheme(isDarkMode ? "light" : "dark")}
                >
                  {isDarkMode ? <SunIcon /> : <MoonIcon />}
                  {isDarkMode ? "Light mode" : "Dark mode"}
                </DropdownMenuItem>
                {onSignOut && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={onSignOut}>
                      <LogOutIcon />
                      Sign out
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
