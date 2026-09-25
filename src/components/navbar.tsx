"use client";
import Link from "next/link";
import { routes } from "@/lib/routes";
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
  const { isDevMode, toggleDevMode, isLoaded } = useDevMode();

  return (
    <NavigationMenu className="max-w-full w-full justify-between px-4 border-b gap-4 box-border">
      <div className="flex items-center my-1">
        <NavigationMenuList>
          <NavigationMenuItem>
            <NavigationMenuLink className="font-medium text-lg" asChild>
              <Link href={routes.home}>CLIC CHAT</Link>
            </NavigationMenuLink>
          </NavigationMenuItem>
        </NavigationMenuList>
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
