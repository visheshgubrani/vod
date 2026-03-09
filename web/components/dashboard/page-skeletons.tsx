"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

function Skeleton({
  className,
}: {
  className?: string;
}) {
  return <div className={cn("animate-pulse rounded-sm bg-card/60", className)} />;
}

export function DashboardLayoutSkeleton() {
  return (
    <div className="flex min-h-screen bg-background">
      <div className="hidden w-18 shrink-0 border-r border-border bg-card/50 lg:block lg:w-66" />
      <div className="flex flex-1 flex-col">
        <div className="border-b border-border bg-card/30 px-6 py-5">
          <div className="flex items-center justify-between">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-9 w-9 rounded-full" />
          </div>
        </div>
        <div className="flex-1 space-y-6 p-6">
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
          <Skeleton className="h-10 w-full sm:w-64" />
        </div>
        <Skeleton className="h-96 w-full" />
      </div>
    </div>
  );
}

export function DashboardAnalyticsSkeleton() {
  return (
    <div className="max-w-7xl space-y-8">
      <Skeleton className="h-28 w-full" />
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
    <div className="max-w-4xl space-y-6">
      <Skeleton className="h-12 w-96" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-[28rem] w-full" />
      <Skeleton className="h-44 w-full" />
    </div>
  );
}

export function DashboardUsageSkeleton() {
  return (
    <div className="space-y-8">
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
    <div className="max-w-2xl space-y-8">
      <Skeleton className="h-12 w-72" />
      <Skeleton className="h-[28rem] w-full" />
      <Skeleton className="h-60 w-full" />
    </div>
  );
}

export function DashboardVideoDetailSkeleton() {
  return (
    <div className="animate-fade-in space-y-6">
      <Skeleton className="h-20 w-full" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        <Skeleton className="h-[22rem] w-full lg:col-span-3" />
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Skeleton className="h-56 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
      <Skeleton className="h-14 w-full" />
      <div className="space-y-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-72 w-full" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Skeleton className="h-44 w-full" />
          <Skeleton className="h-44 w-full" />
        </div>
      </div>
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
