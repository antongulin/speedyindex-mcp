/** Extracted pure measurement fixtures: literal frame oracle and transport deny guard. */
import assert from 'node:assert/strict';

export function compareLiteralFrameOracle() {
  const a = 'https://example.test/é"\\a',
    b = 'https://example.test/Ω/b';
  const observations = {
    size: 2,
    processedCount: 2,
    indexedCount: 1,
    isCompleted: true,
    status: null,
    checkAfter: null,
    awaitingResult: null,
    dripFeed: null,
    days: null,
    daysPassed: null,
    isStopped: null,
  };
  const beforeStatus = {
    id: 'before',
    type: 'google/indexer',
    ...observations,
    targetDomains: null,
    providerCreatedAt: ' status-before Ω ',
  };
  const afterStatus = {
    id: 'after',
    type: 'google/indexer',
    ...observations,
    targetDomains: null,
    providerCreatedAt: ' status-after Ω ',
  };
  const beforeProjection = {
    family: 'google/indexer',
    reportKind: 'links',
    taskId: 'before',
    metadata: {
      ...observations,
      type: 'google/indexer',
      providerCreatedAt: 'report-before é',
    },
    indexedLinks: [a],
    unindexedLinks: [b],
    indexedDuplicateCount: 1,
    unindexedDuplicateCount: 0,
  };
  const afterProjection = {
    family: 'google/indexer',
    reportKind: 'links',
    taskId: 'after',
    metadata: {
      ...observations,
      type: 'google/indexer',
      providerCreatedAt: 'report-after é',
    },
    indexedLinks: [b],
    unindexedLinks: [a],
    indexedDuplicateCount: 1,
    unindexedDuplicateCount: 0,
  };
  const beforeWrapper = {
    projection: beforeProjection,
    donorRawTargetCounts: null,
  };
  const afterWrapper = {
    projection: afterProjection,
    donorRawTargetCounts: null,
  };
  const baseline = [beforeStatus, afterStatus];
  const coverage = {
    observedIndexedCount: 1,
    observedUnindexedCount: 1,
    observedUniqueUrlCount: 2,
    indexedDuplicateCount: 1,
    unindexedDuplicateCount: 0,
    conflictingUrlCount: 0,
    reportedSlotGap: 0,
    indexedEnumerationGap: 0,
  };
  const beforeSummary = {
    status: beforeStatus,
    report: beforeProjection.metadata,
    settled: true,
    coverage: { ...coverage },
  };
  const afterSummary = {
    status: afterStatus,
    report: afterProjection.metadata,
    settled: true,
    coverage: { ...coverage },
  };
  const rows = [
    {
      url: a,
      before: { state: 'indexed', membership: 'indexed' },
      after: { state: 'unindexed', membership: 'unindexed' },
      change: 'reported_indexed_to_unindexed',
    },
    {
      url: b,
      before: { state: 'unindexed', membership: 'unindexed' },
      after: { state: 'indexed', membership: 'indexed' },
      change: 'reported_unindexed_to_indexed',
    },
  ];
  const data = {
    status: 'compared',
    reportKind: 'links',
    family: 'google/indexer',
    beforeTaskId: 'before',
    afterTaskId: 'after',
    scope: {
      basis: 'observed_union',
      direction: 'caller_selected',
      observations: 'non_atomic_provider_reports',
      originalCorpusEquality: 'unknown',
      originalHistory: 'unknown',
      liveState: 'not_observed',
    },
    before: beforeSummary,
    after: afterSummary,
    rows,
    counts: {
      reportedUnindexedToIndexed: 1,
      reportedIndexedToUnindexed: 1,
      unchangedIndexed: 0,
      unchangedUnindexed: 0,
      unknown: 0,
      total: 2,
    },
  };
  const text = JSON.stringify(data);
  const envelope = {
    isError: false,
    content: [{ type: 'text', text }],
    structuredContent: structuredClone(data),
  };
  const beforeArgument = { status: beforeStatus, reports: [beforeProjection] };
  const afterArgument = { status: afterStatus, reports: [afterProjection] };
  const controlParse = {
    success: true,
    data: {
      family: 'google/indexer',
      beforeTaskId: 'before',
      afterTaskId: 'after',
    },
  };
  const beforeStatusParse = {
    success: true,
    data: structuredClone(beforeStatus),
  };
  const afterStatusParse = {
    success: true,
    data: structuredClone(afterStatus),
  };
  const helperBefore = {
    status: beforeStatusParse.data,
    reports: beforeArgument.reports,
  };
  const helperAfter = {
    status: afterStatusParse.data,
    reports: afterArgument.reports,
  };
  const parsedBefore = structuredClone(beforeProjection),
    parsedAfter = structuredClone(afterProjection);
  // A Map is represented by its ordered entries, not by JSON.stringify(Map)=={}.
  const bmEntries = [
    [a, 'indexed'],
    [b, 'unindexed'],
  ];
  const amEntries = [
    [b, 'indexed'],
    [a, 'unindexed'],
  ];
  const callerRoots = [
    beforeArgument,
    afterArgument,
    controlParse,
    beforeStatusParse,
    afterStatusParse,
  ];
  const helperRoots = [
    ...callerRoots,
    helperBefore,
    helperAfter,
    parsedBefore,
    parsedAfter,
    beforeSummary,
    afterSummary,
    bmEntries,
    amEntries,
  ];
  const resultParseImage = { success: true, data: structuredClone(data) };
  const envelopeParseImage = {
    success: true,
    data: envelope.structuredContent,
  };
  const frame = (
    base: unknown,
    before: unknown[],
    after: unknown[],
    second: unknown[],
    fence: unknown,
    work: unknown[],
  ) => [base, before, after, second, fence, work];
  const frames: Record<string, unknown[]> = {
    statusFirstCopy: frame(null, [], [], [], null, [
      beforeStatus,
      structuredClone(beforeStatus),
    ]),
    statusSecondCopy: frame(null, [], [], [], null, [
      [beforeStatus],
      afterStatus,
      structuredClone(afterStatus),
    ]),
    beforeReportCopy: frame(baseline, [], [], [], null, [
      beforeProjection,
      structuredClone(beforeProjection),
    ]),
    afterReportCopy: frame(baseline, [beforeWrapper], [], [], null, [
      afterProjection,
      structuredClone(afterProjection),
    ]),
    statusFenceCopy: frame(
      baseline,
      [beforeWrapper],
      [afterWrapper],
      [],
      null,
      [[beforeStatus], afterStatus, structuredClone(afterStatus)],
    ),
    secondReportCopy: frame(
      baseline,
      [beforeWrapper],
      [afterWrapper],
      [],
      null,
      [beforeProjection, structuredClone(beforeProjection)],
    ),
    secondTaskFence: frame(
      baseline,
      [beforeWrapper],
      [afterWrapper],
      [structuredClone(beforeWrapper)],
      null,
      [],
    ),
    pureDraft: frame(baseline, [beforeWrapper], [afterWrapper], [], null, [
      ...helperRoots,
      rows,
      data,
    ]),
    resultParse: frame(baseline, [beforeWrapper], [afterWrapper], [], null, [
      ...callerRoots,
      data,
      resultParseImage,
    ]),
    envelopeCopy: frame(baseline, [beforeWrapper], [afterWrapper], [], null, [
      data,
      envelopeParseImage,
      envelope,
    ]),
    pendingEnvelope: frame(
      baseline,
      [beforeWrapper],
      [afterWrapper],
      [],
      null,
      [data, envelope],
    ),
  };
  const genericFrame = (work: unknown[]) =>
    frame(baseline, [beforeWrapper], [afterWrapper], [], null, work);
  const [rowA, rowB] = rows;
  assert(rowA && rowB);
  const beforeReadRoots = [
    ...callerRoots,
    helperBefore,
    helperAfter,
    parsedBefore,
    { success: true, data: parsedAfter },
  ];
  frames.genericReadUnionSet = genericFrame([
    ...beforeReadRoots,
    [b, a],
    [b, a],
  ]);
  frames.genericReadIndexedSet = genericFrame([...beforeReadRoots, [b]]);
  frames.genericReadUnindexedSet = genericFrame([...beforeReadRoots, [a]]);
  frames.genericSummarySetScan = genericFrame([
    ...callerRoots,
    helperBefore,
    helperAfter,
    parsedBefore,
    parsedAfter,
    beforeSummary,
    [a],
    [],
  ]);
  frames.genericSummarySetReturn = genericFrame([
    ...callerRoots,
    helperBefore,
    helperAfter,
    parsedBefore,
    parsedAfter,
    beforeSummary,
    [a],
    afterSummary,
  ]);
  frames.genericMembershipUnion = genericFrame([
    ...helperRoots,
    [a, b, b, a],
    [a, b],
    [a, b],
  ]);
  frames.genericRowBuilder = genericFrame([
    ...helperRoots,
    [a, b],
    [rowA],
    rowB.before,
    rowB.after,
    rowB,
  ]);
  const { counts: literalCounts, ...draftWithoutCounts } = data;
  const filterImages = [
    { prefix: {}, selected: [rowB] },
    { prefix: { reportedUnindexedToIndexed: 1 }, selected: [rowA] },
    {
      prefix: { reportedUnindexedToIndexed: 1, reportedIndexedToUnindexed: 1 },
      selected: [],
    },
    {
      prefix: {
        reportedUnindexedToIndexed: 1,
        reportedIndexedToUnindexed: 1,
        unchangedIndexed: 0,
      },
      selected: [],
    },
    {
      prefix: {
        reportedUnindexedToIndexed: 1,
        reportedIndexedToUnindexed: 1,
        unchangedIndexed: 0,
        unchangedUnindexed: 0,
      },
      selected: [],
    },
  ];
  for (const [i, image] of filterImages.entries()) {
    frames[`genericCountFilter${i}`] = genericFrame([
      ...helperRoots,
      rows,
      draftWithoutCounts,
      image.prefix,
      image.selected,
    ]);
  }
  const resultValidationRoots = [
    ...callerRoots,
    data,
    resultParseImage.data,
    [a, b],
  ];
  frames.genericValidatorIdentitySet = genericFrame([
    ...callerRoots,
    data,
    resultParseImage.data,
    [a, b],
    [a, b],
  ]);
  frames.genericValidatorPartitionFilter = genericFrame([
    ...resultValidationRoots,
    [rowA],
  ]);
  frames.genericValidatorCountCompare = genericFrame([
    ...resultValidationRoots,
    literalCounts,
    JSON.stringify(literalCounts),
    JSON.stringify(data.counts),
  ]);
  frames.genericProjectionUnique = frame(baseline, [], [], [], null, [
    {
      family: 'google/indexer',
      reportKind: 'links',
      taskId: 'before',
      metadata: beforeProjection.metadata,
    },
    [a],
    [a],
  ]);
  frames.genericProjectionDuplicateSet = frame(baseline, [], [], [], null, [
    {
      family: 'google/indexer',
      reportKind: 'links',
      taskId: 'before',
      metadata: beforeProjection.metadata,
      indexedLinks: [a],
      unindexedLinks: [b],
    },
    [a],
  ]);
  frames.genericProjectionUnion = frame(baseline, [], [], [], null, [
    { success: true, data: parsedBefore },
    [a, b],
    [a, b],
  ]);
  frames.genericProjectionFreeze = frame(baseline, [], [], [], null, [
    { success: true, data: parsedBefore },
    [a, b],
    Object.values(parsedBefore),
    Object.values(parsedBefore.metadata),
  ]);
  // These are literal Object.values stack images for actual recursive freeze calls.
  // The temporary arrays are distinct application containers; their aliased values still serialize.
  const envelopeTextContent = envelope.content[0];
  assert(envelopeTextContent);
  frames.genericResultFreezeRows = genericFrame([
    ...callerRoots,
    data,
    resultParseImage,
    Object.values(resultParseImage.data),
    Object.values(resultParseImage.data.rows),
    Object.values(rowA),
    Object.values(rowA.before),
  ]);
  frames.genericEnvelopeFreezeText = genericFrame([
    data,
    envelopeParseImage,
    envelope,
    Object.values(envelope),
    Object.values(envelope.content),
    Object.values(envelopeTextContent),
  ]);
  frames.genericEnvelopeFreezeRows = genericFrame([
    data,
    envelopeParseImage,
    envelope,
    Object.values(envelope),
    Object.values(envelope.structuredContent),
    Object.values(envelope.structuredContent.rows),
    Object.values(rowA),
    Object.values(rowA.before),
  ]);
  frames.genericEnvelopeFreezeSummary = genericFrame([
    data,
    envelopeParseImage,
    envelope,
    Object.values(envelope),
    Object.values(envelope.structuredContent),
    Object.values(beforeSummary),
    Object.values(beforeStatus),
  ]);
  const genericNames = Object.keys(frames);

  // Independent finite backlink images: two duplicate before rows across two pages,
  // one after row, three typed target tuples per raw row. No production helper is called.
  const c = 'https://example.test/c',
    e = 'https://example.test/e',
    donor = 'https://example.test/donor';
  const targets = [' Example.test ', ' Example.test '];
  const blBeforeStatus = {
    ...beforeStatus,
    type: 'backlink/checker',
    size: 1,
    processedCount: 1,
    indexedCount: null,
    isCompleted: false,
    targetDomains: targets,
  };
  const blAfterStatus = {
    ...afterStatus,
    type: 'backlink/checker',
    size: 1,
    processedCount: 1,
    indexedCount: null,
    isCompleted: false,
    targetDomains: targets,
  };
  const oldLinks = [
    { url: a, anchor: 'old Ω', nofollow: false },
    { url: b, anchor: '', nofollow: true },
    { url: c, anchor: 'same', nofollow: false },
  ];
  const newLinks = [
    { url: a, anchor: 'new Ω', nofollow: true },
    { url: c, anchor: 'same', nofollow: false },
    { url: e, anchor: 'z', nofollow: false },
  ];
  const [oldA, oldB, oldC] = oldLinks;
  assert(oldA && oldB && oldC);
  const oldSide = { state: 'reported', targetLinks: oldLinks },
    newSide = { state: 'reported', targetLinks: newLinks };
  const oldDonor = {
    donorUrl: donor,
    processedWitness: true,
    evidence: oldSide,
  };
  const newDonor = {
    donorUrl: donor,
    processedWitness: true,
    evidence: newSide,
  };
  const blPage0 = {
    family: 'backlink/checker',
    reportKind: 'backlink',
    taskId: 'before',
    size: 1,
    processedCount: 1,
    isCompleted: false,
    page: 0,
    lastPage: 1,
    donors: [oldDonor],
    rawTargetLinkCount: 3,
    duplicateTargetLinkCount: 0,
  };
  const blPage1 = { ...structuredClone(blPage0), page: 1 };
  const blAfterPage = {
    ...structuredClone(blPage0),
    taskId: 'after',
    lastPage: 0,
    donors: [newDonor],
  };
  const beforePages = [blPage0, blPage1],
    afterPages = [blAfterPage];
  const beforeWrappers = beforePages.map((projection) => ({
    projection,
    donorRawTargetCounts: [3],
  }));
  const afterWrappers = afterPages.map((projection) => ({
    projection,
    donorRawTargetCounts: [3],
  }));
  const blBaseline = [blBeforeStatus, blAfterStatus];
  const blBeforeSummary = {
    status: blBeforeStatus,
    report: {
      size: 1,
      processedCount: 1,
      isCompleted: false,
      lastPage: 1,
      pagesVisited: 2,
    },
    coverage: {
      rawDonorCount: 2,
      observedUniqueDonorCount: 1,
      duplicateDonorCount: 1,
      conflictingDonorCount: 0,
      rawTargetLinkCount: 6,
      duplicateTargetLinkCount: 0,
      reportedSlotGap: 0,
    },
  };
  const blAfterSummary = {
    status: blAfterStatus,
    report: {
      size: 1,
      processedCount: 1,
      isCompleted: false,
      lastPage: 0,
      pagesVisited: 1,
    },
    coverage: {
      rawDonorCount: 1,
      observedUniqueDonorCount: 1,
      duplicateDonorCount: 0,
      conflictingDonorCount: 0,
      rawTargetLinkCount: 3,
      duplicateTargetLinkCount: 0,
      reportedSlotGap: 0,
    },
  };
  const partition = {
    state: 'compared',
    newlyReportedTargetUrls: [e],
    noLongerReportedTargetUrls: [b],
    attributeChangedTargetUrls: [a],
    unchangedTargetUrls: [c],
  };
  const blRow = {
    donorUrl: donor,
    before: oldSide,
    after: newSide,
    comparison: partition,
  };
  const blRows = [blRow];
  const blData = {
    status: 'compared',
    reportKind: 'backlink',
    family: 'backlink/checker',
    beforeTaskId: 'before',
    afterTaskId: 'after',
    scope: { ...data.scope },
    targetScope: {
      provenance: 'matching_current_provider_status',
      targetDomains: [...targets],
      originalTargets: 'unknown',
    },
    before: blBeforeSummary,
    after: blAfterSummary,
    rows: blRows,
    counts: {
      comparedDonors: 1,
      unknownDonors: 0,
      totalDonors: 1,
      newlyReportedTargetUrls: 1,
      noLongerReportedTargetUrls: 1,
      attributeChangedTargetUrls: 1,
      unchangedTargetUrls: 1,
    },
  };
  const blArgB = { status: blBeforeStatus, reports: beforePages },
    blArgA = { status: blAfterStatus, reports: afterPages };
  const blStatusB = { success: true, data: structuredClone(blBeforeStatus) },
    blStatusA = { success: true, data: structuredClone(blAfterStatus) };
  const blHelperB = { status: blStatusB.data, reports: beforePages },
    blHelperA = { status: blStatusA.data, reports: afterPages };
  const blCaller = [
    blArgB,
    blArgA,
    {
      success: true,
      data: {
        family: 'backlink/checker',
        beforeTaskId: 'before',
        afterTaskId: 'after',
      },
    },
    blStatusB,
    blStatusA,
  ];
  const blHelper = [...blCaller, blHelperB, blHelperA];
  const beforeDonorEntries = [[donor, oldSide]],
    afterDonorEntries = [[donor, newSide]];
  const blReturnB = { donors: beforeDonorEntries, summary: blBeforeSummary };
  const blReturnA = { donors: afterDonorEntries, summary: blAfterSummary };
  const outerBacklink = [...blHelper, blReturnB, blReturnA];
  const blFrame = (work: unknown[], second: unknown[] = []) =>
    frame(blBaseline, beforeWrappers, afterWrappers, second, null, work);
  const oldKeyA = JSON.stringify([a, 'old Ω', false]),
    oldKeyB = JSON.stringify([b, '', true]),
    keyC = JSON.stringify([c, 'same', false]);
  const newKeyA = JSON.stringify([a, 'new Ω', true]),
    keyE = JSON.stringify([e, 'z', false]);
  const oldTupleKeys = [oldKeyA, oldKeyB, keyC],
    newTupleKeys = [newKeyA, keyC, keyE];
  const oldAttrs = [
    [a, [JSON.stringify(['old Ω', false])]],
    [b, [JSON.stringify(['', true])]],
    [c, [JSON.stringify(['same', false])]],
  ];
  const newAttrs = [
    [a, [JSON.stringify(['new Ω', true])]],
    [c, [JSON.stringify(['same', false])]],
    [e, [JSON.stringify(['z', false])]],
  ];
  const readBeforeRoots = [
    ...blHelper,
    structuredClone(beforePages),
    beforeDonorEntries,
    [donor],
  ];
  frames.backlinkProjectionSeenSet = blFrame([
    [],
    oldLinks,
    oldTupleKeys,
    { success: true, data: { url: c, anchor: 'same', nofollow: false } },
  ]);
  frames.backlinkProjectionDonorReturn = blFrame([
    [],
    oldLinks,
    oldTupleKeys,
    oldDonor,
  ]);
  frames.backlinkProjectionTupleBuilder = blFrame([
    [],
    [oldA, oldB],
    [oldKeyA, oldKeyB],
    { success: true, data: { url: c, anchor: 'same', nofollow: false } },
    [c, 'same', false],
    keyC,
  ]);
  const oldCanonical = [keyC, oldKeyA, oldKeyB];
  frames.backlinkReadCanonicalKeyBuilder = blFrame([
    ...readBeforeRoots,
    oldCanonical,
    [oldKeyA, oldKeyB],
    [c, 'same', false],
    keyC,
  ]);
  frames.backlinkReadCanonicalSpread = blFrame([
    ...readBeforeRoots,
    oldCanonical,
    [...oldTupleKeys],
    [...oldTupleKeys],
  ]);
  frames.backlinkReadCanonicalCompare = blFrame([
    ...readBeforeRoots,
    oldCanonical,
    [...oldCanonical],
    JSON.stringify(oldCanonical),
    JSON.stringify(oldCanonical),
  ]);
  frames.backlinkReadCoverageFilter = blFrame([
    ...readBeforeRoots,
    { donors: beforeDonorEntries },
    { status: blBeforeStatus, report: blBeforeSummary.report },
    { rawDonorCount: 2, observedUniqueDonorCount: 1, duplicateDonorCount: 1 },
    [oldSide],
    [],
  ]);
  frames.backlinkReadReturn = blFrame([...readBeforeRoots, blReturnB]);
  frames.backlinkAfterRead = blFrame([
    ...blHelper,
    blReturnB,
    structuredClone(afterPages),
    afterDonorEntries,
    [donor],
    blReturnA,
  ]);
  frames.backlinkDonorUnion = blFrame([
    ...outerBacklink,
    [donor, donor],
    [donor],
    [donor],
  ]);
  const partialRow = { donorUrl: donor, before: oldSide, after: newSide };
  frames.backlinkAttributeSetInsert = blFrame([
    ...outerBacklink,
    [donor],
    [],
    partialRow,
    oldAttrs,
    [],
    [JSON.stringify(['new Ω', true])],
  ]);
  frames.backlinkAttributeKeyEncoding = blFrame([
    ...outerBacklink,
    [donor],
    [],
    partialRow,
    oldAttrs,
    [],
    [],
    ['new Ω', true],
    JSON.stringify(['new Ω', true]),
  ]);
  const emptyPartition = {
    state: 'compared',
    newlyReportedTargetUrls: [],
    noLongerReportedTargetUrls: [],
    attributeChangedTargetUrls: [],
    unchangedTargetUrls: [],
  };
  const partialPartition = {
    state: 'compared',
    newlyReportedTargetUrls: [],
    noLongerReportedTargetUrls: [b],
    attributeChangedTargetUrls: [a],
    unchangedTargetUrls: [],
  };
  const sameAttributes = [JSON.stringify(['same', false])];
  frames.backlinkAttributeUnion = blFrame([
    ...outerBacklink,
    [donor],
    [],
    partialRow,
    oldAttrs,
    newAttrs,
    emptyPartition,
    [a, b, c, a, c, e],
    [a, b, c, e],
    [a, b, c, e],
  ]);
  frames.backlinkAttributeCompare = blFrame([
    ...outerBacklink,
    [donor],
    [],
    partialRow,
    oldAttrs,
    newAttrs,
    partialPartition,
    [a, b, c, e],
    sameAttributes,
    [...sameAttributes],
    JSON.stringify(sameAttributes),
    JSON.stringify(sameAttributes),
  ]);
  frames.backlinkAttributeReturn = blFrame([
    ...outerBacklink,
    [donor],
    [],
    partialRow,
    oldAttrs,
    newAttrs,
    partition,
  ]);
  frames.backlinkRowBuilder = blFrame([...outerBacklink, [donor], [], blRow]);
  frames.backlinkPureDraft = blFrame([...outerBacklink, blRows, blData]);
  const blParsedResult = { success: true, data: structuredClone(blData) };
  const blValidationRoots = [...blCaller, blData, blParsedResult.data, [donor]];
  frames.backlinkValidationIdentitySet = blFrame([
    ...blValidationRoots,
    [donor],
  ]);
  frames.backlinkValidationPresentFilter = blFrame([
    ...blValidationRoots,
    [blRow],
    [blRow],
  ]);
  frames.backlinkValidationTupleSet = blFrame([
    ...blValidationRoots,
    oldTupleKeys,
    [...oldTupleKeys],
  ]);
  frames.backlinkValidationTupleBuilder = blFrame([
    ...blValidationRoots,
    [oldKeyA, oldKeyB],
    [c, 'same', false],
    keyC,
  ]);
  frames.backlinkValidationAttributes = blFrame([
    ...blValidationRoots,
    oldAttrs,
    newAttrs,
    partialPartition,
    [a, b, c, e],
    sameAttributes,
    [...sameAttributes],
    JSON.stringify(sameAttributes),
    JSON.stringify(sameAttributes),
  ]);
  frames.backlinkValidationComparison = blFrame([
    ...blValidationRoots,
    partition,
    JSON.stringify(partition),
    JSON.stringify(partition),
  ]);
  frames.backlinkSecondTaskIndex = blFrame(
    [
      [oldDonor, oldDonor],
      [oldDonor, oldDonor],
      [3, 3],
      [true, false],
    ],
    beforeWrappers,
  );
  const blText = JSON.stringify(blData);
  const blEnvelope = {
    isError: false,
    content: [{ type: 'text', text: blText }],
    structuredContent: structuredClone(blData),
  };
  const blEnvelopeParsed = {
    success: true,
    data: blEnvelope.structuredContent,
  };
  const blTextContent = blEnvelope.content[0];
  assert(blTextContent);
  const firstOldLink = oldLinks[0];
  assert(firstOldLink);
  frames.backlinkEnvelopeCopy = blFrame([blData, blEnvelopeParsed, blEnvelope]);
  frames.backlinkResultFreezeRows = blFrame([
    ...blCaller,
    blData,
    blParsedResult,
    Object.values(blParsedResult.data),
    Object.values(blRows),
    Object.values(blRow),
    Object.values(oldSide),
    Object.values(oldLinks),
    Object.values(firstOldLink),
  ]);
  frames.backlinkEnvelopeFreezeText = blFrame([
    blData,
    blEnvelopeParsed,
    blEnvelope,
    Object.values(blEnvelope),
    Object.values(blEnvelope.content),
    Object.values(blTextContent),
  ]);
  frames.backlinkEnvelopeFreezeRows = blFrame([
    blData,
    blEnvelopeParsed,
    blEnvelope,
    Object.values(blEnvelope),
    Object.values(blEnvelope.structuredContent),
    Object.values(blRows),
    Object.values(blRow),
    Object.values(oldSide),
    Object.values(oldLinks),
    Object.values(firstOldLink),
  ]);
  frames.backlinkEnvelopeFreezeSummary = blFrame([
    blData,
    blEnvelopeParsed,
    blEnvelope,
    Object.values(blEnvelope),
    Object.values(blEnvelope.structuredContent),
    Object.values(blBeforeSummary),
    Object.values(blBeforeStatus),
    Object.values(targets),
  ]);
  frames.backlinkProjectionFreeze = blFrame([
    [oldDonor],
    { success: true, data: blPage0 },
    Object.values(blPage0),
    Object.values(blPage0.donors),
    Object.values(oldDonor),
    Object.values(oldSide),
    Object.values(oldLinks),
    Object.values(firstOldLink),
  ]);
  // Keys used only as explicit typed Set images above; no Set is serialized as {}.
  assert.equal(newTupleKeys.length, 3);
  const frameBytes = Object.fromEntries(
    Object.entries(frames).map(([name, value]) => [
      name,
      Buffer.byteLength(JSON.stringify(value), 'utf8'),
    ]),
  );
  const peakBytes = Math.max(...Object.values(frameBytes));
  const frameByteCount = (name: string) => {
    const count = frameBytes[name];
    if (typeof count !== 'number') throw new Error('Missing literal frame.');
    return count;
  };
  return {
    frames,
    frameBytes,
    peakBytes,
    fixturePeaks: {
      generic: Math.max(...genericNames.map(frameByteCount)),
      backlink: Math.max(
        ...Object.keys(frames)
          .filter((name) => name.startsWith('backlink'))
          .map(frameByteCount),
      ),
    },
    backlinkEnvelopeBytes: Buffer.byteLength(
      JSON.stringify(blEnvelope),
      'utf8',
    ),
    rawBacklinkDonorVisits: [2, 1, 2, 1],
    rawBacklinkTargetVisits: [6, 3, 6, 3],
    envelopeBytes: Buffer.byteLength(JSON.stringify(envelope), 'utf8'),
    rawGenericVisits: [3, 3, 3, 3],
    rawGenericTotal: 12,
  };
}

export function installCompareDefaultDeny() {
  const original = globalThis.fetch;
  let calls = 0;
  const deny = () => {
    calls++;
    throw new Error('Compare fixture default transport denied.');
  };
  const guarded: typeof fetch = Object.assign(async () => deny(), {
    preconnect: deny,
  });
  globalThis.fetch = guarded;
  return Object.freeze({
    nativeFetch: original,
    calls: () => calls,
    restore() {
      globalThis.fetch = original;
    },
  });
}
