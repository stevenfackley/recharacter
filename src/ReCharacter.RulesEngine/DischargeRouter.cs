namespace ReCharacter.RulesEngine;

public sealed class DischargeRouter(IClock clock)
{
    public RoutingResult Route(DischargeFacts facts)
    {
        if (facts.DischargeDate > clock.Today)
            throw new ArgumentException("Discharge date cannot be in the future.", nameof(facts));

        var names = BoardDirectory.For(facts.Branch);
        var deadline = DrbWindow.Deadline(facts.DischargeDate);
        var drbOpen = DrbWindow.IsOpen(facts.DischargeDate, clock.Today);
        var flags = new List<RoutingFlag>();

        // A Dishonorable Discharge can only be adjudged by a general court-martial (UCMJ Art.
        // 19 — a special court-martial may adjudge a BCD but never a DD), so it implies GCM even
        // when the upstream flag is unset (e.g. DD-214 extraction defaulted it to false).
        var isGeneralCourtMartial =
            facts.WasGeneralCourtMartial || facts.Characterization == DischargeCharacterization.DishonorableDischarge;

        // The DRB (10 U.S.C. §1553) cannot review general-court-martial discharges; the BCMR must.
        var mustUseBcmr = isGeneralCourtMartial || !drbOpen;

        if (isGeneralCourtMartial)
            flags.Add(RoutingFlag.GeneralCourtMartialRequiresBcmr);
        else if (!drbOpen)
            flags.Add(RoutingFlag.PastDrbWindow);

        if (mustUseBcmr)
            flags.Add(RoutingFlag.BcmrThreeYearStatuteWaiverLikely);

        if (facts.Branch == Branch.CoastGuard)
            flags.Add(RoutingFlag.CoastGuardDhsPolicyDiffers);

        if (facts.Characterization == DischargeCharacterization.Uncharacterized)
            flags.Add(RoutingFlag.EntryLevelSeparationUncharacterized);

        if (facts.Characterization == DischargeCharacterization.Honorable)
            flags.Add(RoutingFlag.AlreadyHonorableNothingToUpgrade);

        var board = mustUseBcmr ? ReviewBoard.Bcmr : ReviewBoard.Drb;
        var form = board == ReviewBoard.Drb ? ApplicationForm.DD293 : ApplicationForm.DD149;
        var boardName = board == ReviewBoard.Drb ? names.DrbName : names.BcmrName;

        var available = new List<ReviewBoard>();
        if (drbOpen && !isGeneralCourtMartial)
            available.Add(ReviewBoard.Drb);
        available.Add(ReviewBoard.Bcmr);

        return new RoutingResult
        {
            RecommendedBoard = board,
            RecommendedForm = form,
            BoardName = boardName,
            AvailableBoards = available,
            DrbDeadline = deadline,
            DrbWindowOpen = drbOpen,
            Flags = flags
        };
    }
}
