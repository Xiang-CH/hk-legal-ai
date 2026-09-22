"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Switch } from "./ui/switch";
import { Label } from "./ui/label";

import {
  NavigationMenu,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
} from "./ui/navigation-menu"
import { useDevMode } from "@/hooks/use-dev-mode";

export const Navbar = () => {
  const pathname = usePathname();
  const { isDevMode, toggleDevMode, isLoaded } = useDevMode();

  return (
    <NavigationMenu className="max-w-full w-full justify-between px-4 border-b gap-4 box-border">
      <div className="flex items-center my-1">
        <NavigationMenuList>
          <NavigationMenuItem>
            <NavigationMenuLink className="font-medium text-lg" asChild>
              <Link href="/">CLIC CHAT</Link>
            </NavigationMenuLink>
          </NavigationMenuItem>
        </NavigationMenuList>
        
        {/* <NavigationMenuList className="ml-4">
          <NavigationMenuItem>
              <NavigationMenuLink 
                className={cn(
                  "group inline-flex h-9 w-max items-center justify-center rounded-md bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus:outline-none disabled:pointer-events-none disabled:opacity-50",
                  pathname === "/search" && "underline underline-offset-4 border-primary"
                )}
                asChild
              >
                <Link href="/search">Search</Link>
              </NavigationMenuLink>
          </NavigationMenuItem>
          
          <NavigationMenuItem>
              <NavigationMenuLink 
                className={cn(
                  "group inline-flex h-9 w-max items-center justify-center rounded-md bg-background px-4 py-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus:outline-none disabled:pointer-events-none disabled:opacity-50",
                  pathname === "/consult" && "underline underline-offset-4 border-primary"
                )}
                asChild
              >
                <Link href="/consult">Consult</Link>
                
              </NavigationMenuLink>
          </NavigationMenuItem>
        </NavigationMenuList> */}
      </div>

      <div className="hidden md:flex items-center space-x-2">
        <Label htmlFor="dev-mode" className="text-sm">Dev Mode</Label>
        {isLoaded && (
          <Switch
            id="dev-mode"
            checked={isDevMode}
            onCheckedChange={toggleDevMode}
          />
        )}
      </div>
    </NavigationMenu>
  );
};
