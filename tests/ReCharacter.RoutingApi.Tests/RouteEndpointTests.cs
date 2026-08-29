using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Xunit;

namespace ReCharacter.RoutingApi.Tests;

public class RouteEndpointTests(WebApplicationFactory<Program> factory)
    : IClassFixture<WebApplicationFactory<Program>>
{
    [Fact]
    public async Task Get_Healthz_ReturnsOk()
    {
        var client = factory.CreateClient();

        var response = await client.GetAsync("/healthz");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var json = await response.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);

        Assert.Equal("ok", doc.RootElement.GetProperty("status").GetString());
    }

    [Fact]
    public async Task Post_Route_MarineOthWithinWindow_ReturnsDrbDd293()
    {
        var client = factory.CreateClient();

        var body = new
        {
            branch = "MarineCorps",
            dischargeDate = "2024-06-01",
            characterization = "OtherThanHonorable",
            wasGeneralCourtMartial = false
        };

        var response = await client.PostAsJsonAsync("/route", body);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var json = await response.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.Equal("Drb", root.GetProperty("recommendedBoard").GetString());
        Assert.Equal("DD293", root.GetProperty("recommendedForm").GetString());
        Assert.Equal("NDRB", root.GetProperty("boardName").GetString());
        Assert.True(root.GetProperty("drbWindowOpen").GetBoolean());
    }

    [Fact]
    public async Task Post_Route_FutureDischargeDate_ReturnsBadRequest()
    {
        var client = factory.CreateClient();

        var body = new
        {
            branch = "Army",
            dischargeDate = "2099-01-01",
            characterization = "OtherThanHonorable",
            wasGeneralCourtMartial = false
        };

        var response = await client.PostAsJsonAsync("/route", body);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains("application/problem+json", response.Content.Headers.ContentType?.ToString());
    }

    [Fact]
    public async Task Post_Route_MalformedJsonBody_Returns400ProblemJson()
    {
        var client = factory.CreateClient();

        // Binding-layer failure (invalid JSON) — must share the same problem+json
        // shape as the domain guard, so the web client can rely on one 400 contract.
        var content = new StringContent("{ this is not json", Encoding.UTF8, "application/json");
        var response = await client.PostAsync("/route", content);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains("application/problem+json", response.Content.Headers.ContentType?.ToString());
    }

    [Fact]
    public async Task Post_Route_DishonorableDischarge_OmittedGcmFlag_RoutesToBcmr()
    {
        // DD-214 extraction can return null for the GCM flag, which the web tier defaults to
        // false; the payload below omits the field entirely to reproduce that. A Dishonorable
        // Discharge can only be adjudged by a general court-martial (UCMJ Art. 19), so this must
        // still route to BCMR/DD-149 even with no flag on the wire.
        var client = factory.CreateClient();

        var body = new
        {
            branch = "Army",
            dischargeDate = "2020-01-01",
            characterization = "DishonorableDischarge"
        };

        var response = await client.PostAsJsonAsync("/route", body);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var json = await response.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.Equal("Bcmr", root.GetProperty("recommendedBoard").GetString());
        Assert.Equal("DD149", root.GetProperty("recommendedForm").GetString());

        var flags = root.GetProperty("flags").EnumerateArray().Select(f => f.GetString()).ToArray();
        Assert.Contains("GeneralCourtMartialRequiresBcmr", flags);

        var availableBoards = root.GetProperty("availableBoards").EnumerateArray().Select(b => b.GetString()).ToArray();
        Assert.Equal(new[] { "Bcmr" }, availableBoards);

        // Full DTO shape over the wire, asserted here since no other test covers it.
        Assert.True(root.TryGetProperty("drbDeadline", out var drbDeadline));
        Assert.Equal("2035-01-01", drbDeadline.GetString());
        Assert.True(root.GetProperty("drbWindowOpen").GetBoolean());
        Assert.Equal("ABCMR", root.GetProperty("boardName").GetString());
    }

    [Fact]
    public async Task Post_Route_MissingRequiredField_ReturnsBadRequestProblemJson()
    {
        var client = factory.CreateClient();

        var body = new
        {
            // branch omitted — a required field.
            dischargeDate = "2020-01-01",
            characterization = "OtherThanHonorable"
        };

        var response = await client.PostAsJsonAsync("/route", body);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains("application/problem+json", response.Content.Headers.ContentType?.ToString());
    }

    [Fact]
    public async Task Get_Healthz_ContentTypeIsApplicationJson()
    {
        var client = factory.CreateClient();

        var response = await client.GetAsync("/healthz");

        Assert.Equal("application/json", response.Content.Headers.ContentType?.MediaType);
        Assert.Equal("utf-8", response.Content.Headers.ContentType?.CharSet);
    }

    [Fact]
    public async Task Post_Route_EnumsRoundTripAsStrings_NotIntegers()
    {
        // JsonStringEnumConverter is registered on the HTTP JSON options: enums are accepted by
        // name on the way in, and every enum-typed field and array element comes back as a JSON
        // string. The Next.js consumer keys on these names, so an integer would be a breaking change.
        var client = factory.CreateClient();

        var body = new
        {
            branch = "Army",
            dischargeDate = "2024-06-01",
            characterization = "Honorable", // yields exactly one flag, so the flags array is non-empty
            wasGeneralCourtMartial = false
        };

        var response = await client.PostAsJsonAsync("/route", body);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var json = await response.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        var board = root.GetProperty("recommendedBoard");
        Assert.Equal(JsonValueKind.String, board.ValueKind);
        Assert.Equal("Drb", board.GetString());

        var form = root.GetProperty("recommendedForm");
        Assert.Equal(JsonValueKind.String, form.ValueKind);
        Assert.Equal("DD293", form.GetString());

        var availableBoards = root.GetProperty("availableBoards").EnumerateArray().ToArray();
        Assert.All(availableBoards, b => Assert.Equal(JsonValueKind.String, b.ValueKind));
        Assert.Equal(new[] { "Drb", "Bcmr" }, availableBoards.Select(b => b.GetString()).ToArray());

        var flags = root.GetProperty("flags").EnumerateArray().ToArray();
        Assert.All(flags, f => Assert.Equal(JsonValueKind.String, f.ValueKind));
        Assert.Equal(new[] { "AlreadyHonorableNothingToUpgrade" }, flags.Select(f => f.GetString()).ToArray());
    }

    [Theory]
    [InlineData("""{ "branch": "Starfleet", "dischargeDate": "2024-06-01", "characterization": "OtherThanHonorable" }""")]
    [InlineData("""{ "branch": "Army", "dischargeDate": "not-a-date", "characterization": "OtherThanHonorable" }""")]
    public async Task Post_Route_UnbindableFieldValue_Returns400ProblemJson(string rawJson)
    {
        // Unknown enum name and unparseable date are both System.Text.Json failures inside model
        // binding: they surface as BadHttpRequestException, which the exception handler's
        // StatusCodeSelector must map back to 400 problem+json rather than the default 500.
        var client = factory.CreateClient();

        var content = new StringContent(rawJson, Encoding.UTF8, "application/json");
        var response = await client.PostAsync("/route", content);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains("application/problem+json", response.Content.Headers.ContentType?.ToString());
    }

    [Fact]
    public async Task Post_Route_UndefinedBranchInteger_Returns400ProblemJson()
    {
        // JsonStringEnumConverter still accepts integer literals, so 999 binds to (Branch)999 and
        // gets past model binding. BoardDirectory then throws ArgumentOutOfRangeException, which is
        // an ArgumentException and so hits the endpoint's domain guard: 400 problem+json, not a 500.
        var client = factory.CreateClient();

        var content = new StringContent(
            """{ "branch": 999, "dischargeDate": "2024-06-01", "characterization": "OtherThanHonorable" }""",
            Encoding.UTF8, "application/json");
        var response = await client.PostAsync("/route", content);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Contains("application/problem+json", response.Content.Headers.ContentType?.ToString());

        var json = await response.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);

        Assert.Contains("Unknown branch", doc.RootElement.GetProperty("detail").GetString());
    }

    [Fact]
    public async Task Get_UnknownRoute_Returns404ProblemJson()
    {
        // Nothing threw here — no endpoint matched — so this is the UseStatusCodePages path, which
        // hands the bare 404 to the IProblemDetailsService registered by AddProblemDetails.
        var client = factory.CreateClient();

        var response = await client.GetAsync("/nope");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Contains("application/problem+json", response.Content.Headers.ContentType?.ToString());

        var json = await response.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.Equal(404, root.GetProperty("status").GetInt32());
        Assert.Equal("Not Found", root.GetProperty("title").GetString());
    }
}
