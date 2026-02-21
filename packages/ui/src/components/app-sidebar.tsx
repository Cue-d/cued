"use client";

import * as React from "react";
import {
  InboxIcon,
  LinkIcon,
  SettingsIcon,
  LogOutIcon,
  SunIcon,
  MoonIcon,
  ChevronsUpDownIcon,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { useTheme } from "next-themes";
import { CuedMark } from "./cued-mark";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar";
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
  SidebarMenuButton,
  SidebarMenuItem,
} from "./ui/sidebar";

const navigation = [
  { title: "Inbox", href: "/inbox", icon: InboxIcon },
];

interface AppSidebarProps extends React.ComponentProps<typeof Sidebar> {
  user?: {
    name?: string;
    email?: string;
    imageUrl?: string;
  } | null;
  onSignOut?: () => void;
}

export function AppSidebar({
  user,
  onSignOut,
  ...props
}: AppSidebarProps) {
  const { setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  const [logoHovered, setLogoHovered] = React.useState(false);

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
          className="flex items-center gap-2 cursor-pointer"
          onMouseEnter={() => setLogoHovered(true)}
          onMouseLeave={() => setLogoHovered(false)}
        >
          <CuedMark size={24} />
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
                  {user?.imageUrl ? (
                    <AvatarImage src={user.imageUrl} alt={user?.name ?? "User"} />
                  ) : null}
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
