"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

function Skeleton({ className }: { className?: string }) {
  return <div className={cn("dash-skeleton rounded-lg", className)} />;
}

export function DashboardLayoutSkeleton() {
  return (
    <div className="flex min-h-screen bg-background">
      <div className="hidden w-62 shrink-0 border-r border-border bg-panel-quiet lg:block" />
      <div className="flex flex-1 flex-col">
        <div className="border-b border-border px-4 py-4 md:px-8">
          <div className="flex items-center justify-between">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="size-10 rounded-full" />
          </div>
        </div>
        <div className="flex-1 space-y-6 p-4 md:p-8">
          <Skeleton className="h-10 w-72" />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
          </div>
          <Skeleton className="h-80 w-full" />
        </div>
      </div>
    </div>
  );
}

export function DashboardOverviewSkeleton() {
  return (
    <div className="w-full space-y-8">
      <Skeleton className="h-12 w-80" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
      <div className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-11 w-full sm:w-64" />
        </div>
        <Skeleton className="h-96 w-full" />
      </div>
    </div>
  );
}

export function DashboardAnalyticsSkeleton() {
  return (
    <div className="w-full space-y-8">
      <Skeleton className="h-24 w-full" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
        <Skeleton className="h-32" />
      </div>
      <Skeleton className="h-96 w-full" />
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Skeleton className="h-80" />
        <Skeleton className="h-80" />
        <Skeleton className="h-80" />
      </div>
    </div>
  );
}

export function DashboardTablePageSkeleton() {
  return (
    <div className="w-full space-y-6">
      <Skeleton className="h-12 w-96" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-[28rem] w-full" />
      <Skeleton className="h-44 w-full" />
    </div>
  );
}

export function DashboardUsageSkeleton() {
  return (
    <div className="w-full space-y-8">
      <Skeleton className="h-12 w-80" />
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Skeleton className="h-44" />
        <Skeleton className="h-44" />
      </div>
      <Skeleton className="h-96 w-full" />
      <Skeleton className="h-[30rem] w-full" />
      <Skeleton className="h-36 w-full" />
    </div>
  );
}

export function DashboardSettingsSkeleton() {
  return (
    <div className="w-full space-y-8">
      <Skeleton className="h-12 w-72" />
      <Skeleton className="h-[28rem] w-full" />
      <Skeleton className="h-60 w-full" />
    </div>
  );
}

export function DashboardVideoDetailSkeleton() {
  return (
    <div className="w-full space-y-6">
      <Skeleton className="h-20 w-full" />
      <Skeleton className="aspect-video w-full" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Skeleton className="h-44 w-full" />
        <Skeleton className="h-44 w-full" />
      </div>
      <Skeleton className="h-72 w-full" />
    </div>
  );
}

export function DashboardSectionSkeleton({
  className,
}: {
  className?: string;
}) {
  return <Skeleton className={cn("h-48 w-full", className)} />;
}
