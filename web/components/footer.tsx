import Link from "next/link";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { ArrowRight, Linkedin } from "lucide-react";
import { FaXTwitter } from "react-icons/fa6";

export function Footer() {
  return (
    <footer className="relative pt-20 pb-8 overflow-hidden">
      {/* Background */}
      <div className="absolute inset-0 bg-gradient-to-t from-card/30 to-background" />

      <div className="relative z-10 max-w-7xl mx-auto px-6">
        {/* CTA Section */}
        <div className="bg-card/70 border-2 border-card rounded-xl p-8 md:p-16 lg:py-20 text-center mb-20 relative overflow-hidden">
          <div
            className="absolute inset-0 opacity-15 bg-left bg-cover md:hidden"
            style={{ backgroundImage: "url('/images/boxes.svg')" }}
          />
          <div
            className="absolute inset-0 opacity-25 bg-center bg-cover hidden md:block"
            style={{ backgroundImage: "url('/images/boxes.svg')" }}
          />
          {/* Decorative elements */}
          <div className="absolute top-0 left-0 w-64 h-64 bg-primary/10 rounded-full blur-3xl" />
          <div className="absolute bottom-0 right-0 w-64 h-64 bg-accent/10 rounded-full blur-3xl" />

          <div className="relative z-10">
            <h2 className="text-3xl md:text-4xl lg:text-5xl font-bold mb-6">
              Ready to <span className="gradient-text">Save 90%</span> on Video?
            </h2>
            <p className="text-base md:text-lg text-foreground/70 max-w-2xl mx-auto mb-8">
              Join thousands of developers streaming video at a fraction of the
              cost. Start free, scale without limits.
            </p>
            <div className="flex flex-col md:w-fit whitespace-nowrap mx-auto w-full sm:flex-row items-center justify-center gap-6">
              <Link href="/signup" className="w-full">
                <Button className="group w-full py-3 rounded-full bg-[#704fd5] text-white hover:bg-[#704fd5]/90">
                  Start Free Trial
                  <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                </Button>
              </Link>
              <Button
                variant="ghost"
                size="lg"
                className="h-auto py-3 w-full bg-mauve-700/70 shadow-md font-medium hover:bg-mauve-800"
              >
                Schedule a Demo
              </Button>
            </div>
            {/* <p className="text-sm text-muted-foreground mt-6">
              No credit card required • 14-day free trial • Cancel anytime
            </p> */}
          </div>
        </div>

        {/* One-line Footer */}
        <div className=" pt-8">
          <div className="flex flex-wrap items-center justify-center md:justify-between gap-6 sm:gap-5 text-sm">
            <div className="flex gap-5  sm:gap-10 items-center">
              <Link href="/" className="flex items-center gap-2">
                <Image
                  src="/logo.svg"
                  alt="ClipMux logo"
                  width={24}
                  height={24}
                  className="h-7 w-auto"
                />
                <span className="text-lg tracking-wider font-semibold text-foreground font-dashboard-heading">
                  ClipMux
                </span>
              </Link>

              <div className="flex items-center gap-6">
                <a
                  href="#"
                  className="text-muted-foreground rounded-full bg-mauve-700  p-2 hover:text-foreground transition-colors"
                  aria-label="X"
                >
                  <FaXTwitter className="size-4.5 fill-foreground text-foreground" />
                </a>
                <a
                  href="#"
                  className="text-muted-foreground rounded-full bg-mauve-700  p-2 hover:text-foreground transition-colors"
                  aria-label="LinkedIn"
                >
                  <Linkedin className="size-4.5 fill-foreground/50 text-foreground" />
                </a>
              </div>
            </div>

            <div className="flex items-center gap-6 md:gap-8 text-muted-foreground">
              <Link
                href="/privacy"
                className="hover:text-foreground transition-colors"
              >
                Privacy
              </Link>
              <Link
                href="/terms"
                className="hover:text-foreground transition-colors"
              >
                Terms
              </Link>
              <Link
                href="/cookies"
                className="hover:text-foreground transition-colors"
              >
                Cookies
              </Link>
            </div>

            <p className="text-muted-foreground/80">
              © 2026 ClipMux. All rights reserved.
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
