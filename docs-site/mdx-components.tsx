import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import { Accordion, Accordions } from 'fumadocs-ui/components/accordion';
import { File, Folder, Files } from 'fumadocs-ui/components/files';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { TypeTable } from 'fumadocs-ui/components/type-table';

/**
 * Components every MDX page can use without an import.
 *
 * `defaultMdxComponents` ships only Callout/Cards/Card and the HTML overrides.
 * The guides also need `<Steps>` for walkthroughs, `<Tabs>` for the
 * package-manager / framework / SDK-vs-curl variants, `<Files>` for project
 * trees and `<TypeTable>` for API field tables, so they are registered here
 * once instead of imported in every page.
 */
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    Accordion,
    Accordions,
    File,
    Files,
    Folder,
    Step,
    Steps,
    Tab,
    Tabs,
    TypeTable,
    ...components,
  };
}
