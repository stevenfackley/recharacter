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
}
