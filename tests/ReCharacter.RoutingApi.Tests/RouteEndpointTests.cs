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
}
