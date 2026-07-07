# Stateless .NET routing service. Build context is the REPO ROOT (needs the
# RulesEngine project): docker build -f src/ReCharacter.RoutingApi/Dockerfile .

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY src/ ./src/
RUN dotnet publish src/ReCharacter.RoutingApi -c Release -o /out

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS run
WORKDIR /app
COPY --from=build /out .
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080
USER app
ENTRYPOINT ["dotnet", "ReCharacter.RoutingApi.dll"]
