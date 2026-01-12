import "./globals.css";
import { GeistSans } from "geist/font/sans";
import { Toaster } from "sonner";
import { cn } from "@/lib/utils";
import { Navbar } from "@/components/navbar";
import { DevModeProvider } from "@/hooks/use-dev-mode";
import { ThemeProvider } from "@/components/theme-provider"
import { PrismaClient } from '@/prisma/client'

export const metadata = {
  title: "CLIC CHAT",
  description:
    "AI system to community legal education",
};

const prisma = new PrismaClient();

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  prisma.$connect();
  
  return (
    <html lang="en" className="auto light" style={{colorScheme:"light"}}>
      <head></head>
      <body className={cn(GeistSans.className, "antialiased max-h-screen overflow-hidden")}>
        <Toaster position="top-center" richColors />
        <DevModeProvider>
          <ThemeProvider
            attribute="class"
            defaultTheme="auto"
            enableSystem={true}
            disableTransitionOnChange
          >
            <Navbar />
            {children}
          </ThemeProvider>
        </DevModeProvider>
      </body>
    </html>
  );
}
